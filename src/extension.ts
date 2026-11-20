import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { BiliAuth, type SecretStore } from './bilibili/auth';
import { fetchDanmaku } from './bilibili/danmaku';
import { fetchLiveDanmaku, fetchLiveRoom } from './server/live';
import { LiveDanmakuHub } from './server/liveDanmaku';
import { describeVideo } from './bilibili/parse';
import { getPlayInfo } from './bilibili/playurl';
import { getSettings, migrateLegacyFitSetting } from './config';
import { findAudioTranscoder } from './server/audioTranscode';
import { startApiServer, type ApiServerHandle } from './server/apiServer';
import { pruneAudioCache } from './server/audioCache';
import { renderSkinConfig, type DanmakuItem, type SkinConfig } from './shared/types';
import { ExtensionState } from './state';
import { findChecksumMismatches, fixChecksums } from './workbench/checksums';
import { locateWorkbench, type WorkbenchInstall } from './workbench/locate';
import { applyPatch, isPatched, restorePatch, writeSkinConfig } from './workbench/patcher';

const TOKEN_KEY = 'bilibiliPlayer.apiToken';
const SKIN_VERSION_KEY = 'bilibiliPlayer.skinVersion';

interface Services {
  auth: BiliAuth;
  state: ExtensionState;
  server: ApiServerHandle;
  token: string;
  liveDanmaku: LiveDanmakuHub;
}

let output: vscode.OutputChannel;
let statusBar: vscode.StatusBarItem;
let services: Promise<Services> | undefined;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Bilibili 皮肤');
  context.subscriptions.push(output);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.text = '$(device-camera-video) B站';
  statusBar.tooltip = 'B站视频皮肤：点击开启';
  statusBar.command = 'bilibiliPlayer.enable';
  statusBar.show();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('bilibiliPlayer.enable', () => runEnable(context)),
    vscode.commands.registerCommand('bilibiliPlayer.disable', () => runDisable()),
    vscode.commands.registerCommand('bilibiliPlayer.showOutput', () => output.show(true)),
  );

  void migrateLegacyFitSetting().catch(() => undefined);

  services = initServices(context).catch((error: unknown) => {
    log(`初始化失败：${toMessage(error)}`, '错误');
    throw error;
  });
  void services.catch(() => undefined);
}

export async function deactivate(): Promise<void> {
  statusBar?.dispose();
  output?.dispose();
  if (services) {
    try {
      const started = await services;
      started.liveDanmaku.dispose();
      await started.server.close();
    } catch {
      // 初始化失败时没有 server 可关
    }
  }
}

async function initServices(context: vscode.ExtensionContext): Promise<Services> {
  const secretStore: SecretStore = {
    get: async (key) => context.secrets.get(key),
    store: async (key, value) => {
      await context.secrets.store(key, value);
    },
    delete: async (key) => {
      await context.secrets.delete(key);
    },
  };

  const auth = new BiliAuth(secretStore, log);
  await auth.init();

  const token = await getOrCreateToken(context);
  const state = new ExtensionState(context, auth);
  const version = String(context.extension.packageJSON.version ?? '0.0.0');
  const clientLogPath = path.join(context.globalStorageUri.fsPath, 'client.log');
  const cacheDir = path.join(context.globalStorageUri.fsPath, 'audio-cache');
  try {
    fs.mkdirSync(path.dirname(clientLogPath), { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });
    rotateClientLog(clientLogPath);
  } catch {
    // 目录已存在或不可写，下面 append 失败会静默忽略
  }

  const audioCacheMaxBytes = getSettings().audioCacheMaxMb * 1024 * 1024;
  const cacheStats = pruneAudioCache(cacheDir, audioCacheMaxBytes);
  log(
    `音频缓存：${cacheStats.files} 个文件 / ${formatBytes(cacheStats.bytes)}（上限 ${getSettings().audioCacheMaxMb} MB，目录 ${cacheDir}）`,
    '启动',
  );

  let apiPort = 0;
  // 弹幕整段拉取一次就够，按 cid 缓存
  const danmakuCache = new Map<number, DanmakuItem[]>();
  const liveDanmaku = new LiveDanmakuHub(
    () => auth.client(),
    (message) => log(message, '弹幕'),
    (roomId) => fetchLiveDanmaku(auth.client(), roomId),
  );
  const server = await startApiServer({
    token,
    version,
    cacheDir,
    audioCacheMaxBytes,
    getState: () => state.snapshot(),
    patchState: (patch) => state.patch(patch),
    getPlayInfo: async (ref, qn) => {
      const info = await getPlayInfo(auth.client(), ref, qn);
      log(
        `${info.title} · ${info.qualities.find((quality) => quality.qn === info.quality)?.desc ?? `${info.quality}P`} · ${describeVideo(ref)}`,
        '播放',
      );
      if (!apiPort) {
        return info;
      }
      // 音轨要在扩展宿主里转成 MP3/WAV：VS Code 的 libffmpeg 没有 AAC 解码器。
      const transcoded = (audioUrl: string) =>
        `http://127.0.0.1:${apiPort}/api/audio/transcoded?url=${encodeURIComponent(audioUrl)}&token=${encodeURIComponent(token)}`;
      // 视频也走宿主代理：部分 CDN（尤其 1080P60 等高码率）会校验 Referer，
      // 渲染进程的 <video> 带不了 Referer，直连会 403 → MEDIA_ERR_SRC_NOT_SUPPORTED。
      const proxied = (videoUrl: string) =>
        `http://127.0.0.1:${apiPort}/api/video?url=${encodeURIComponent(videoUrl)}&token=${encodeURIComponent(token)}`;
      return {
        ...info,
        url: proxied(info.url),
        backupUrls: info.backupUrls?.map(proxied) ?? [],
        audioUrl: info.audioUrl ? transcoded(info.audioUrl) : undefined,
        audioBackupUrls: info.audioBackupUrls?.map(transcoded),
      };
    },
    getDanmaku: async (cid) => {
      const cached = danmakuCache.get(cid);
      if (cached) {
        return cached;
      }
      const items = await fetchDanmaku(auth.client(), cid);
      danmakuCache.set(cid, items);
      log(`已加载 ${items.length} 条弹幕（cid ${cid}）`, '弹幕');
      return items;
    },
    onDanmaku: (items, live) => {
      if (items.length === 0) {
        return;
      }
      ensureDanmakuScroll();
      logLines(
        items.map((item) => (live ? item.text : `${formatClock(item.time)} ${item.text}`)),
        '弹幕',
      );
    },
    getLiveRoom: (input, qn) => fetchLiveRoom(auth.client(), input, qn),
    getLiveDanmaku: (roomId) => liveDanmaku.poll(roomId),
    loginQr: () => auth.generateQr(),
    loginPoll: (key) => auth.pollQr(key),
    logout: () => auth.logout(),
    log,
    clientLog: (entry) => {
      const payload = {
        ...entry,
        at: new Date(entry.at ?? Date.now()).toISOString(),
      };
      try {
        fs.appendFileSync(clientLogPath, `${JSON.stringify(payload)}\n`);
        clientLogWrites += 1;
        if (clientLogWrites % 200 === 0) {
          rotateClientLog(clientLogPath);
        }
      } catch {
        // 磁盘不可写时只保留输出通道
      }
      const level = entry.level ?? 'info';
      if (level !== 'info') {
        log(
          `${entry.message ?? ''}${entry.data === undefined ? '' : ` ${stringifyForLog(entry.data)}`}`,
          '客户端',
        );
      }
    },
  });

  apiPort = server.port;
  log(`本地 API 已启动：http://127.0.0.1:${server.port}`, '启动');
  log(`客户端日志：${clientLogPath}`, '启动');
  const transcoder = findAudioTranscoder();
  log(
    transcoder
      ? `音频转码器：${transcoder.name}`
      : `音频转码器：未找到（视频会只有画面没有声音）${
          process.platform === 'win32'
            ? '；Windows 安装方法：winget install Gyan.FFmpeg（装完重启 VS Code），或把 ffmpeg.exe 所在目录加到 PATH'
            : '；macOS：brew install ffmpeg'
        }`,
    '启动',
  );

  const started: Services = { auth, state, server, token, liveDanmaku };
  await syncSkinConfig(context, started);
  await ensureVisibleAfterUpdate(context, started, version);
  updateStatusBar(started);

  return started;
}

async function ensureVisibleAfterUpdate(
  context: vscode.ExtensionContext,
  started: Services,
  version: string,
): Promise<void> {
  const install = locateWorkbench(vscode.env.appRoot, vscode.version);
  if (!install || !isPatched(install)) {
    return;
  }

  const lastVersion = context.globalState.get<string>(SKIN_VERSION_KEY);
  if (lastVersion === version) {
    return;
  }

  await started.state.patch({ visible: true });
  await context.globalState.update(SKIN_VERSION_KEY, version);
  log(`皮肤版本 ${lastVersion ?? '未知'} → ${version}，已重新显示。`, '皮肤');
}

async function getOrCreateToken(context: vscode.ExtensionContext): Promise<string> {
  const existing = context.globalState.get<string>(TOKEN_KEY);
  if (existing) {
    return existing;
  }

  const token = randomBytes(24).toString('hex');
  await context.globalState.update(TOKEN_KEY, token);
  return token;
}

async function syncSkinConfig(context: vscode.ExtensionContext, started: Services): Promise<void> {
  const install = locateWorkbench(vscode.env.appRoot, vscode.version);
  if (!install || !isPatched(install)) {
    return;
  }

  const config = skinConfigFor(context, started);
  try {
    const current = readSkinConfigFile(install);
    const changed =
      !current ||
      current.token !== config.token ||
      current.port !== config.port ||
      current.version !== config.version;

    if (!changed) {
      writeSkinConfig(install, renderSkinConfig(config));
      return;
    }

    // 版本/端口/令牌变了：重新注入一遍（同时换掉 ?v= 缓存键，避免渲染进程读到旧资源）
    applyPatch(install, readSkinAssets(context, config), {
      backupRoot: path.join(context.globalStorageUri.fsPath, 'workbench-backups'),
      cacheKey: String(Date.now()),
      log,
    });
    log('皮肤资源已更新（版本/端口/令牌变化），重载窗口后生效。', '皮肤');
    void vscode.window
      .showInformationMessage('B站皮肤已随扩展更新，需要重载窗口生效。', '重载窗口')
      .then((choice) => {
        if (choice) {
          void vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      });
  } catch (error) {
    log(`同步皮肤配置失败：${toMessage(error)}`, '错误');
  }
}

/** 读取工作台目录里现有的皮肤配置（判断是否需要重新注入）。 */
function readSkinConfigFile(install: WorkbenchInstall): SkinConfig | null {
  try {
    const file = path.join(path.dirname(install.htmlPath), 'bilibili-skin.config.js');
    const raw = fs.readFileSync(file, 'utf8');
    const match = raw.match(/window\.__BILI_SKIN_CONFIG__\s*=\s*(\{[\s\S]*\});/);
    return match ? (JSON.parse(match[1]) as SkinConfig) : null;
  } catch {
    return null;
  }
}

function skinConfigFor(context: vscode.ExtensionContext, started: Services): SkinConfig {
  return {
    port: started.server.port,
    token: started.token,
    version: String(context.extension.packageJSON.version ?? '0.0.0'),
  };
}

function updateStatusBar(started: Services): void {
  if (!statusBar) {
    return;
  }

  if (started.auth.loggedIn && started.auth.user) {
    statusBar.text = '$(device-camera-video) B站';
    statusBar.tooltip = `B站视频皮肤 · 已登录：${started.auth.user.name}`;
  } else {
    statusBar.text = '$(device-camera-video) B站';
    statusBar.tooltip = 'B站视频皮肤 · 未登录（可播放 480P/720P）';
  }
}

/**
 * 开启：没注入过就先注入，已注入则只是把皮肤显示出来。
 */
async function runEnable(context: vscode.ExtensionContext): Promise<void> {
  try {
    const install = locateWorkbench(vscode.env.appRoot, vscode.version);
    if (!install) {
      throw new Error('未找到 VS Code 的 workbench.html，请确认使用的是桌面版 VS Code');
    }

    if (!isPatched(install)) {
      await runApply(context);
      return;
    }

    const started = await requireServices();
    await started.state.patch({ visible: true });
    void vscode.window.showInformationMessage('B站皮肤已开启：右下角 HUD 可播放视频（若没出现请重载窗口）。');
  } catch (error) {
    reportError(error);
  }
}

/** 关闭（还原）：移除注入、恢复 CSP 与校验和。 */
async function runDisable(): Promise<void> {
  await runRestore();
}

async function runApply(context: vscode.ExtensionContext): Promise<void> {
  try {
    const install = locateWorkbench(vscode.env.appRoot, vscode.version);
    if (!install) {
      throw new Error('未找到 VS Code 的 workbench.html，请确认使用的是桌面版 VS Code');
    }

    const started = await requireServices();
    const answer = await vscode.window.showWarningMessage(
      '应用皮肤会修改 VS Code 安装目录中的 workbench.html',
      {
        modal: true,
        detail:
          `文件：${install.htmlPath}\n` +
          '扩展会自动备份原文件、重写 CSP，并同步 product.json 校验和，避免“安装已损坏”提示。\n' +
          'VS Code 升级后需要重新应用；可随时运行“还原皮肤”恢复原状。',
      },
      '应用并重载',
      '仅应用',
    );
    if (!answer) {
      return;
    }

    const assets = readSkinAssets(context, skinConfigFor(context, started));
    const backupRoot = path.join(context.globalStorageUri.fsPath, 'workbench-backups');
    await started.state.patch({ visible: true });
    applyPatch(install, assets, { backupRoot, cacheKey: String(Date.now()), log });
    await context.globalState.update(SKIN_VERSION_KEY, String(context.extension.packageJSON.version ?? '0.0.0'));
    log(`皮肤已应用到 ${install.htmlPath}`, '皮肤');

    const mismatches = findChecksumMismatches(install.appRoot, install.productJsonPath);
    if (mismatches.length > 0) {
      log(`检测到 ${mismatches.length} 个文件校验和不一致（可能来自其它工具的修改）。`, '皮肤');
      const list = mismatches
        .slice(0, 6)
        .map((mismatch) => `• ${mismatch.key}`)
        .join('\n');
      const choice = await vscode.window.showWarningMessage(
        `检测到 ${mismatches.length} 个文件校验和不一致，可能出现“安装已损坏”提示`,
        {
          modal: true,
          detail:
            `${list}${mismatches.length > 6 ? `\n… 共 ${mismatches.length} 个文件` : ''}\n\n` +
            '修复会用当前文件重算 product.json 校验和，不改动代码文件。',
        },
        '修复校验和并重载',
        '稍后处理',
      );

      if (choice === '修复校验和并重载') {
        const fixed = fixChecksums(install.appRoot, install.productJsonPath, log);
        log(`已修复 ${fixed.length} 个校验和。`, '皮肤');
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      } else {
        void vscode.window.showInformationMessage(
          '皮肤已应用；如果出现“安装已损坏”，运行“B站皮肤: 修复校验和”即可。',
        );
      }
      return;
    }

    if (answer === '应用并重载') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    } else {
      void vscode.window.showInformationMessage('皮肤已写入，重载窗口后生效。');
    }
  } catch (error) {
    reportError(error);
  }
}

async function runRestore(): Promise<void> {
  try {
    const install = locateWorkbench(vscode.env.appRoot, vscode.version);
    if (!install) {
      throw new Error('未找到 VS Code 的 workbench.html');
    }
    if (!isPatched(install)) {
      void vscode.window.showInformationMessage('当前没有应用皮肤，无需还原。');
      return;
    }

    const answer = await vscode.window.showWarningMessage(
      '确定要还原 VS Code 工作台吗？',
      { modal: true, detail: '将移除注入的脚本/样式，并恢复 CSP 与校验和。' },
      '还原并重载',
      '仅还原',
    );
    if (!answer) {
      return;
    }

    restorePatch(install, { log });
    log('已还原工作台。', '皮肤');

    if (answer === '还原并重载') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    } else {
      void vscode.window.showInformationMessage('已还原，重载窗口后生效。');
    }
  } catch (error) {
    reportError(error);
  }
}

function readSkinAssets(
  context: vscode.ExtensionContext,
  config: SkinConfig,
): { js: string; css: string; configJs: string } {
  const distDir = vscode.Uri.joinPath(context.extensionUri, 'dist').fsPath;
  const jsPath = path.join(distDir, 'skin.js');
  const cssPath = path.join(distDir, 'skin.css');

  if (!fs.existsSync(jsPath) || !fs.existsSync(cssPath)) {
    throw new Error('未找到 skin.js / skin.css，请先运行 npm run compile');
  }

  return {
    js: fs.readFileSync(jsPath, 'utf8'),
    css: fs.readFileSync(cssPath, 'utf8'),
    configJs: renderSkinConfig(config),
  };
}

async function requireServices(): Promise<Services> {
  if (!services) {
    throw new Error('扩展尚未初始化完成');
  }
  return services;
}

type LogTag = '启动' | '皮肤' | '播放' | '弹幕' | '客户端' | '错误';

let clientLogWrites = 0;

/** 客户端日志超过 5MB 就轮转成 .old（只保留一份历史）。 */
function rotateClientLog(file: string): void {
  try {
    if (fs.statSync(file).size <= 5 * 1024 * 1024) {
      return;
    }
    const old = `${file}.old`;
    fs.rmSync(old, { force: true });
    fs.renameSync(file, old);
  } catch {
    // 日志轮转失败不影响主流程
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.round(bytes / 1024)} KB`;
}

function clockNow(): string {
  const now = new Date();
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

function log(message: string, tag?: LogTag): void {
  try {
    const time = clockNow();
    output?.appendLine(tag ? `[${time}] [${tag}] ${message}` : `[${time}] ${message}`);
  } catch {
    // 重载窗口时输出通道可能已关闭，不能让它中断注入/还原流程
  }
}

/** 一批日志合成一次 append：输出面板只刷一帧，跟随滚动更稳。 */
function logLines(messages: string[], tag?: LogTag): void {
  if (messages.length === 0) {
    return;
  }
  try {
    const time = clockNow();
    const prefix = tag ? `[${tag}] ` : '';
    output?.append(`${messages.map((message) => `[${time}] ${prefix}${message}`).join('\n')}\n`);
  } catch {
    // 同上
  }
}

let danmakuScrollReady = false;

/**
 * VS Code 的「智能滚动」会在用户点过输出面板后锁住滚动，
 * 弹幕一条条追加时看起来就是“不自动滚到底部”。这里按设置关掉它。
 */
function ensureDanmakuScroll(): void {
  if (danmakuScrollReady) {
    return;
  }
  danmakuScrollReady = true;
  try {
    if (!getSettings().danmakuAutoScroll) {
      return;
    }
    const config = vscode.workspace.getConfiguration('output');
    if (config.get<boolean>('smartScroll.enabled', true)) {
      void config.update('smartScroll.enabled', false, vscode.ConfigurationTarget.Global).then(
        () => log('已关闭 output.smartScroll.enabled，弹幕会保持滚动到底部（可在设置里改回）', '弹幕'),
        () => undefined,
      );
    }
  } catch {
    // 读取/写入设置失败时忽略
  }
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '0:00';
  }
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  }
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function reportError(error: unknown): void {
  const raw = toMessage(error);
  const denied = /EACCES|EPERM|access is denied|permission denied/i.test(raw);
  const message =
    denied && process.platform === 'win32'
      ? `${raw}\n（没有写入 VS Code 安装目录的权限：请以管理员身份运行 VS Code，或者使用用户级安装版的 VS Code）`
      : denied
        ? `${raw}\n（没有写入 VS Code 安装目录的权限：请检查文件权限，或用有权限的账号运行）`
        : raw;
  log(`错误：${message}`, '错误');
  void vscode.window.showErrorMessage(`B站皮肤：${message}`);
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringifyForLog(value: unknown): string {
  try {
    return JSON.stringify(value)?.slice(0, 2000) ?? String(value);
  } catch {
    return String(value);
  }
}
