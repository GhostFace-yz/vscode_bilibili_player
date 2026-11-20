import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { findAudioTranscoder, type AudioTranscoder } from './audioTranscode';
import { detectContentAspect, type ContentAspect } from './contentAspect';
import { TEST_TONE_MP3 } from './tone';
import { PORT_RANGE } from '../shared/types';
import type {
  DanmakuItem,
  LoginPoll,
  LoginQr,
  PlayInfo,
  SkinState,
  StatePatch,
  VideoRef,
} from '../shared/types';

export const API_VERSION = 3;

let lastDiagnostics: { at: number; payload: unknown } | null = null;
/** 画面宽高比探测结果：key = bvid:cid（探测很慢，必须复用） */
const contentAspectCache = new Map<string, ContentAspect | null>();
const contentAspectInflight = new Map<string, Promise<ContentAspect | null>>();
const diagnosticsHistory: { at: number; payload: unknown }[] = [];
const DIAGNOSTICS_HISTORY_LIMIT = 600;

export interface ClientLogEntry {
  level?: 'info' | 'warn' | 'error';
  message?: string;
  data?: unknown;
  at?: number;
}

export interface ApiServerDeps {
  token: string;
  getState(): Promise<SkinState>;
  patchState(patch: StatePatch): Promise<SkinState>;
  getPlayInfo(ref: VideoRef, qn: number): Promise<PlayInfo>;
  getDanmaku?(cid: number): Promise<DanmakuItem[]>;
  onDanmaku?(items: DanmakuItem[]): void;
  loginQr(): Promise<LoginQr>;
  loginPoll(key: string): Promise<LoginPoll>;
  logout(): Promise<void>;
  version: string;
  cacheDir: string;
  log?(message: string): void;
  clientLog?(entry: ClientLogEntry): void;
}

export interface ApiServerHandle {
  port: number;
  close(): Promise<void>;
}

export async function startApiServer(deps: ApiServerDeps): Promise<ApiServerHandle> {
  let lastError: unknown;

  for (const port of PORT_RANGE) {
    const server = createServer(deps);
    try {
      await listen(server, port);
      return {
        port,
        close: () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
          }),
      };
    } catch (error) {
      lastError = error;
      if (!isAddrInUse(error)) {
        throw error;
      }
      deps.log?.(`端口 ${port} 被占用，尝试下一个`);
    }
  }

  throw new Error(`本地端口 ${PORT_RANGE[0]}-${PORT_RANGE[PORT_RANGE.length - 1]} 均被占用`, {
    cause: lastError,
  });
}

function createServer(deps: ApiServerDeps): http.Server {
  return http.createServer((req, res) => {
    void handleRequest(req, res, deps).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      deps.log?.(`API 错误：${message}`);
      sendJson(res, 500, { error: message });
    });
  });
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, deps: ApiServerDeps): Promise<void> {
  setCorsHeaders(res);
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;

  if (path === '/api/health') {
    sendJson(res, 200, { ok: true, version: deps.version, apiVersion: API_VERSION });
    return;
  }

  if (!isAuthorized(req, url, deps.token)) {
    sendJson(res, 401, { error: '无效的本地访问令牌' });
    return;
  }

  if (path === '/api/ping') {
    sendJson(res, 200, { ok: true, version: deps.version, apiVersion: API_VERSION });
    return;
  }

  if (path === '/api/state' && req.method === 'GET') {
    sendJson(res, 200, await deps.getState());
    return;
  }

  if (path === '/api/state' && req.method === 'POST') {
    const patch = await readJson<StatePatch>(req);
    sendJson(res, 200, await deps.patchState(normalizePatch(patch)));
    return;
  }

  if (path === '/api/play' && req.method === 'GET') {
    const qn = toInt(url.searchParams.get('qn')) ?? 80;
    const page = toInt(url.searchParams.get('page'));
    const ref: VideoRef = {
      bvid: url.searchParams.get('bvid') ?? undefined,
      aid: url.searchParams.get('aid') ?? undefined,
      page: page && page > 0 ? page : undefined,
    };
    const info = await deps.getPlayInfo(ref, qn);
    sendJson(res, 200, info);
    return;
  }

  if (path === '/api/danmaku' && req.method === 'GET') {
    const cid = toInt(url.searchParams.get('cid'));
    if (!cid) {
      sendJson(res, 400, { error: '缺少 cid 参数' });
      return;
    }
    const items = deps.getDanmaku ? await deps.getDanmaku(cid) : [];
    sendJson(res, 200, { ok: true, items });
    return;
  }

  if (path === '/api/danmaku/emit' && req.method === 'POST') {
    const body = await readJson<{ items?: unknown }>(req);
    const items = normalizeDanmakuItems(body.items);
    if (items.length > 0) {
      deps.onDanmaku?.(items);
    }
    sendJson(res, 200, { ok: true, count: items.length });
    return;
  }

  if (path === '/api/content-aspect' && req.method === 'GET') {
    const videoUrl = url.searchParams.get('url');
    if (!videoUrl) {
      sendJson(res, 400, { error: '缺少 url 参数' });
      return;
    }
    const key = url.searchParams.get('key') ?? videoUrl;
    const duration = toInt(url.searchParams.get('duration')) ?? 0;
    const aspect = await resolveContentAspect(key, videoUrl, duration, deps);
    sendJson(res, 200, aspect ? { ok: true, ...aspect } : { ok: false });
    return;
  }

  if (path === '/api/audio' && req.method === 'GET') {
    await proxyAudio(req, res, url);
    return;
  }

  if (path === '/api/audio/transcoded' && (req.method === 'GET' || req.method === 'HEAD')) {
    await serveTranscodedAudio(req, res, url, deps);
    return;
  }

  if (path === '/api/test-tone.wav' && req.method === 'GET') {
    const wav = getTestToneWav();
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Length': wav.length,
      'Cache-Control': 'no-store',
    });
    res.end(wav);
    return;
  }

  if (path === '/api/test-tone.mp3' && req.method === 'GET') {
    const mp3 = Buffer.from(TEST_TONE_MP3, 'base64');
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': mp3.length,
      'Cache-Control': 'no-store',
    });
    res.end(mp3);
    return;
  }

  if (path === '/api/client-log' && req.method === 'POST') {
    const entry = await readJson<ClientLogEntry>(req);
    deps.clientLog?.(entry);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === '/api/diagnostics' && req.method === 'POST') {
    const payload = await readJson<unknown>(req);
    const sample = { at: Date.now(), payload };
    lastDiagnostics = sample;
    diagnosticsHistory.push(sample);
    if (diagnosticsHistory.length > DIAGNOSTICS_HISTORY_LIMIT) {
      diagnosticsHistory.shift();
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === '/api/diagnostics' && req.method === 'GET') {
    if (url.searchParams.get('history') !== null) {
      sendJson(res, 200, { latest: lastDiagnostics, history: diagnosticsHistory });
      return;
    }
    sendJson(res, 200, lastDiagnostics ?? { ok: true, empty: true });
    return;
  }

  if (path === '/api/login/qr' && req.method === 'GET') {
    sendJson(res, 200, await deps.loginQr());
    return;
  }

  if (path === '/api/login/poll' && req.method === 'GET') {
    const key = url.searchParams.get('key');
    if (!key) {
      sendJson(res, 400, { error: '缺少 qrcode key' });
      return;
    }
    sendJson(res, 200, await deps.loginPoll(key));
    return;
  }

  if (path === '/api/logout' && req.method === 'POST') {
    await deps.logout();
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

const transcodeJobs = new Map<string, Promise<void>>();

/**
 * VS Code 的 libffmpeg 没有 AAC 解码器，直接把 B 站 m4s 交给 <audio> 会报
 * DEMUXER_ERROR_NO_SUPPORTED_STREAMS。这里先转成 MP3（ffmpeg）或 WAV（afconvert），
 * 转码结果按 m4s 路径缓存，后续播放/拖动都直接走 Range。
 */
async function serveTranscodedAudio(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  deps: ApiServerDeps,
): Promise<void> {
  let target: URL;
  try {
    target = new URL(url.searchParams.get('url') ?? '');
  } catch {
    sendJson(res, 400, { error: '缺少或非法 url' });
    return;
  }
  if (target.protocol !== 'https:' || !isAllowedAudioHost(target.hostname)) {
    sendJson(res, 400, { error: '不支持的音轨地址' });
    return;
  }

  const transcoder = findAudioTranscoder(url.searchParams.get('format') === 'wav' ? 'wav' : 'mp3');
  if (!transcoder) {
    sendJson(res, 503, {
      error: '没有可用的音频转码器：请安装 ffmpeg（macOS 也可使用系统自带 afconvert）',
    });
    return;
  }

  const key = createHash('sha1').update(target.pathname).digest('hex').slice(0, 24);
  const file = path.join(deps.cacheDir, `${key}.${transcoder.extension}`);
  try {
    await ensureTranscoded(target, file, transcoder, deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log?.(`音轨转码失败：${message}`);
    sendJson(res, 502, { error: `音轨转码失败：${message}` });
    return;
  }
  await serveFile(req, res, file, transcoder.contentType);
}

async function ensureTranscoded(
  target: URL,
  file: string,
  transcoder: AudioTranscoder,
  deps: ApiServerDeps,
): Promise<void> {
  try {
    if (fs.statSync(file).size > 0) {
      return;
    }
  } catch {
    // 还没缓存
  }

  const existing = transcodeJobs.get(file);
  if (existing) {
    await existing;
    return;
  }

  const job = (async () => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const input = `${file}.source.m4s`;
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp.${transcoder.extension}`;
    try {
      await downloadToFile(target, input);
      deps.log?.(`音轨转码：${transcoder.name} → ${path.basename(file)}`);
      await transcoder.convert(input, tmp);
      await fs.promises.rename(tmp, file);
    } finally {
      await fs.promises.rm(input, { force: true });
      await fs.promises.rm(tmp, { force: true });
    }
    pruneCache(deps.cacheDir, 8);
  })();

  transcodeJobs.set(file, job);
  try {
    await job;
  } finally {
    transcodeJobs.delete(file);
  }
}

async function downloadToFile(target: URL, file: string): Promise<void> {
  const upstream = await fetch(target, {
    headers: {
      Referer: 'https://www.bilibili.com/',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    },
  });
  if (!upstream.ok || !upstream.body) {
    throw new Error(`音轨下载 HTTP ${upstream.status}`);
  }
  await pipeline(
    Readable.fromWeb(upstream.body as unknown as import('node:stream/web').ReadableStream),
    fs.createWriteStream(file),
  );
}

async function serveFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  file: string,
  contentType: string,
): Promise<void> {
  const stat = await fs.promises.stat(file);
  const total = stat.size;
  const range = req.headers.range;
  let start = 0;
  let end = total - 1;
  let status = 200;

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      start = match[1] ? Number(match[1]) : 0;
      end = match[2] ? Number(match[2]) : total - 1;
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < total) {
        end = Math.min(end, total - 1);
        status = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      } else {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` }).end();
        return;
      }
    }
  }

  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  req.on('close', () => stream.destroy());
  stream.pipe(res);
}

function pruneCache(dir: string, keep: number): void {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.mp3') || name.endsWith('.wav'))
      .map((name) => ({ name, time: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    for (const entry of files.slice(keep)) {
      fs.rmSync(path.join(dir, entry.name), { force: true });
    }
  } catch {
    // 清理失败不影响播放
  }
}

function isAllowedAudioHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host.endsWith('.bilivideo.com') ||
    host.endsWith('.bilivideo.cn') ||
    host.endsWith('.mountaintoys.cn') ||
    host.includes('akamaized') ||
    host.endsWith('.bilibili.com')
  );
}

/**
 * 把 B 站音轨从扩展宿主转发给 workbench 的 <audio>。
 * 直接让渲染进程请求 CDN 的 m4s 时，VS Code 里会出现 MEDIA_ERR_SRC_NOT_SUPPORTED；
 * 这里统一补 Referer/UA、把 octet-stream 改成 audio/mp4，并转发 Range。
 */
async function proxyAudio(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const raw = url.searchParams.get('url');
  if (!raw) {
    sendJson(res, 400, { error: '缺少 url' });
    return;
  }
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    sendJson(res, 400, { error: '非法 url' });
    return;
  }
  if (target.protocol !== 'https:') {
    sendJson(res, 400, { error: '只允许 https 音轨' });
    return;
  }
  if (!isAllowedAudioHost(target.hostname)) {
    sendJson(res, 400, { error: '不支持的音轨域名' });
    return;
  }

  const headers: Record<string, string> = {
    Referer: 'https://www.bilibili.com/',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  };
  if (req.headers.range) {
    headers.Range = req.headers.range;
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, { headers });
  } catch (error) {
    sendJson(res, 502, { error: `音轨上游请求失败：${error instanceof Error ? error.message : String(error)}` });
    return;
  }
  if (!upstream.ok) {
    sendJson(res, upstream.status, { error: `音轨上游 HTTP ${upstream.status}` });
    return;
  }

  res.statusCode = upstream.status;
  const contentType = upstream.headers.get('content-type') ?? '';
  res.setHeader(
    'Content-Type',
    contentType.includes('octet-stream') || !contentType ? 'audio/mp4' : contentType,
  );
  for (const name of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const value = upstream.headers.get(name);
    if (value) {
      res.setHeader(name, value);
    }
  }
  res.setHeader('Cache-Control', 'no-store');

  if (!upstream.body) {
    res.end();
    return;
  }
  const body = Readable.fromWeb(upstream.body as unknown as import('node:stream/web').ReadableStream);
  req.on('close', () => body.destroy());
  body.pipe(res);
}

let cachedTone: Buffer | null = null;

/**
 * 1 秒 440Hz 正弦波，用来验证 workbench 里的 <audio> 能否出声。
 * 走 http://127.0.0.1 而不是 data:，避免被 CSP 的 media-src 拦掉。
 */
function getTestToneWav(): Buffer {
  if (cachedTone) {
    return cachedTone;
  }
  const sampleRate = 44100;
  const seconds = 1.2;
  const samples = Math.floor(sampleRate * seconds);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const fade = Math.min(1, i / (sampleRate * 0.02), (samples - i) / (sampleRate * 0.05));
    const value = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.35 * fade;
    data.writeInt16LE(Math.round(value * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  cachedTone = Buffer.concat([header, data]);
  return cachedTone;
}

function setCorsHeaders(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-bili-token');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Max-Age', '600');
}

function isAuthorized(req: http.IncomingMessage, url: URL, token: string): boolean {
  const header = req.headers['x-bili-token'];
  const provided = Array.isArray(header) ? header[0] : header ?? url.searchParams.get('token') ?? '';
  return provided === token;
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 256 * 1024) {
      throw new Error('请求体过大');
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {} as T;
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

function normalizePatch(patch: StatePatch): StatePatch {
  const normalized: StatePatch = {};

  if (typeof patch.visible === 'boolean') {
    normalized.visible = patch.visible;
  }
  if (typeof patch.openLogin === 'boolean') {
    normalized.openLogin = patch.openLogin;
  }
  if (patch.video === null) {
    normalized.video = null;
  } else if (patch.video && typeof patch.video === 'object') {
    normalized.video = {
      bvid: typeof patch.video.bvid === 'string' ? patch.video.bvid : undefined,
      aid: typeof patch.video.aid === 'string' ? patch.video.aid : undefined,
      page: toInt(String(patch.video.page)) ?? undefined,
    };
  }
  if (patch.settings && typeof patch.settings === 'object') {
    normalized.settings = patch.settings;
  }

  return normalized;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function toInt(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

function isAddrInUse(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
}

async function resolveContentAspect(
  key: string,
  videoUrl: string,
  duration: number,
  deps: ApiServerDeps,
): Promise<ContentAspect | null> {
  const cached = contentAspectCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const inflight = contentAspectInflight.get(key);
  if (inflight) {
    return inflight;
  }

  const task = detectContentAspect(videoUrl, duration)
    .then((result) => {
      contentAspectCache.set(key, result);
      if (result) {
        deps.log?.(
          `画面宽高比探测：${key} → ${result.width}x${result.height} (${result.aspect.toFixed(3)}${result.cropped ? '，已裁黑边' : '，无黑边'})`,
        );
      } else {
        deps.log?.(`画面宽高比探测失败：${key}，回退到视频原始比例`);
      }
      return result;
    })
    .catch((error: unknown) => {
      deps.log?.(`画面宽高比探测异常：${error instanceof Error ? error.message : String(error)}`);
      contentAspectCache.set(key, null);
      return null;
    })
    .finally(() => {
      contentAspectInflight.delete(key);
    });

  contentAspectInflight.set(key, task);
  return task;
}

function normalizeDanmakuItems(value: unknown): DanmakuItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: DanmakuItem[] = [];
  for (const entry of value.slice(0, 50)) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const { time, text } = entry as { time?: unknown; text?: unknown };
    if (typeof time !== 'number' || !Number.isFinite(time) || typeof text !== 'string') {
      continue;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      continue;
    }
    items.push({ time, text: trimmed.slice(0, 200) });
  }
  return items;
}
