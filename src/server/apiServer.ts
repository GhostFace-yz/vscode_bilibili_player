import * as http from 'node:http';
import { PORT_RANGE } from '../shared/types';
import type {
  LoginPoll,
  LoginQr,
  PlayInfo,
  SkinState,
  StatePatch,
  VideoRef,
} from '../shared/types';

export const API_VERSION = 2;

let lastDiagnostics: { at: number; payload: unknown } | null = null;

export interface ApiServerDeps {
  token: string;
  getState(): Promise<SkinState>;
  patchState(patch: StatePatch): Promise<SkinState>;
  getPlayInfo(ref: VideoRef, qn: number): Promise<PlayInfo>;
  loginQr(): Promise<LoginQr>;
  loginPoll(key: string): Promise<LoginPoll>;
  logout(): Promise<void>;
  version: string;
  log?(message: string): void;
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

  if (path === '/api/diagnostics' && req.method === 'POST') {
    const payload = await readJson<unknown>(req);
    lastDiagnostics = { at: Date.now(), payload };
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === '/api/diagnostics' && req.method === 'GET') {
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
