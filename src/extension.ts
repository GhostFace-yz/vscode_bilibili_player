import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
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
import { hudStats, startApiServer, type ApiServerHandle } from './server/apiServer';
import { pruneAudioCache } from './server/audioCache';
import { preferReachableUrl } from './server/mediaProbe';
import { renderSkinConfig, type DanmakuItem, type SkinConfig } from './shared/types';
import { ENABLED_KEY, ExtensionState } from './state';
import { findChecksumMismatches, fixChecksums } from './workbench/checksums';
import { locateWorkbench, type WorkbenchInstall } from './workbench/locate';
import {
  applyPatch,
  isPatched,
  restorePatch,
  SKIN_CONFIG,
  SKIN_CSS,
  SKIN_JS,
  writeSkinConfig,
} from './workbench/patcher';

const TOKEN_KEY = 'bilibiliPlayer.apiToken';
const SKIN_VERSION_KEY = 'bilibiliPlayer.skinVersion';
/** 用户是否开过皮肤：VS Code 升级会覆盖 workbench.html，靠它决定要不要自动补回注入。 */
/** 应用补丁后的那一次重载要自动显示；之后每次启动都默认关闭，等用户执行「开启」。 */
const SHOW_ONCE_KEY = 'bilibiliPlayer.showOnce';

interface Services {
  auth: BiliAuth;
  state: ExtensionState;
  server: ApiServerHandle;
  /** 本窗口的 API 端口，用来判断「是不是我」 */
  port: number;
  token: string;
  liveDanmaku: LiveDanmakuHub;
}

/** 全局只有一个窗口能开启：记录占用者的端口 + 会话号 */
const OWNER_KEY = 'bilibiliPlayer.ownerWindow';
interface WindowOwner {
  port: number;
  /** 扩展宿主会话号：端口会被复用，靠它区分“同一个窗口”和“上个会话残留” */
  session: string;
  at: number;
}
/** 本次扩展激活的会话号（每个窗口每次启动都不同） */
const SESSION_ID = randomBytes(8).toString('hex');

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
    vscode.commands.registerCommand('bilibiliPlayer.disable', () => runDisable(context)),
    vscode.commands.registerCommand('bilibiliPlayer.showOutput', () => output.show(true)),
    vscode.commands.registerCommand('bilibiliPlayer.diagnose', () => runDiagnose(context)),
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
    // HUD 用这个特征串把端口绑回自己这个窗口（多窗口时 config 文件是共用的）
    getWindowHint: () => windowHint(),
    sessionId: SESSION_ID,
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

      // playurl 给的第一个 CDN 偶尔是坏的（403/超时），交给 <video> 就是错误码 4：
      // 表现是“开启后没有画面，点重试才正常”。先探一下，把能用的排到最前面。
      // 音轨不做探测：mcdn 的地址带连接数/令牌限制，多开一条探测连接反而容易
      // 让后面的真实下载卡住；音轨本身有 WAV / 备用线路 / 720P 的回退链。
      const videoPick = await preferReachableUrl(info.url, info.backupUrls ?? []);

      return {
        ...info,
        url: proxied(videoPick.url),
        backupUrls: videoPick.backups.map(proxied),
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
  // 多窗口排查用：HUD 会用这串去匹配自己窗口的 document.title
  log(`窗口特征：${windowHint() || '(空)'}`, '启动');
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

  const started: Services = { auth, state, server, port: server.port, token, liveDanmaku };
  const install = locateWorkbench(vscode.env.appRoot, vscode.version);
  const patched = Boolean(install && isPatched(install));
  if (patched) {
    // 默认关闭：每次进 VS Code 都从关闭状态开始，只有执行「开启」才显示。
    // 只有刚应用完补丁的那次重载例外（showOnce），否则首次开启会看不到效果。
    const showOnce = context.globalState.get<boolean>(SHOW_ONCE_KEY, false);
    // 先写 enabled 再改 visible：HUD 每 2s 轮询一次，顺序反了会看到
    // “visible=true 但 enabled=false”，被当成“已还原”而自己收起来。
    await context.globalState.update(ENABLED_KEY, true);
    await started.state.patch({ visible: showOnce });
    if (showOnce) {
      await context.globalState.update(SHOW_ONCE_KEY, false);
      await context.globalState.update(OWNER_KEY, {
        port: server.port,
        session: SESSION_ID,
        at: Date.now(),
      } satisfies WindowOwner);
    }
  }
  // 上个会话 Cmd+Q 留下的占用记录：端口可能被别的窗口复用了，
  // 不清掉会让新窗口「开启」时误报"另一个窗口已开启"。
  const staleOwner = context.globalState.get<WindowOwner>(OWNER_KEY);
  if (staleOwner && !(await isOwnerAlive(staleOwner, server.port))) {
    await context.globalState.update(OWNER_KEY, undefined);
    log('已清理上个会话残留的窗口占用记录', '皮肤');
  }

  await syncSkinConfig(context, started);
  if (install && !patched) {
    await reapplyAfterUpdate(context, started, version);
  }
  updateStatusBar(started);

  return started;
}

/**
 * VS Code 升级会重新覆盖 workbench.html，注入和 CSP 一起丢失。
 * 只要用户之前开过皮肤，就自动补回注入，省得每次升级后还要手动“开启”。
 */
async function reapplyAfterUpdate(
  context: vscode.ExtensionContext,
  started: Services,
  version: string,
): Promise<void> {
  if (!context.globalState.get<boolean>(ENABLED_KEY, false)) {
    return;
  }

  const install = locateWorkbench(vscode.env.appRoot, vscode.version);
  if (!install || isPatched(install)) {
    return;
  }

  try {
    // 多个窗口同时启动时只让一个窗口写工作台，避免校验和互相踩。
    const lockPath = path.join(context.globalStorageUri.fsPath, 'workbench-apply.lock');
    if (isFresh(lockPath, 60_000)) {
      log('另一个窗口正在恢复皮肤注入，跳过。', '皮肤');
      return;
    }
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, String(Date.now()));

    applyPatch(install, readSkinAssets(context, skinConfigFor(context, started)), {
      backupRoot: path.join(context.globalStorageUri.fsPath, 'workbench-backups'),
      cacheKey: String(Date.now()),
      log,
    });
    await started.state.patch({ visible: false });
    await context.globalState.update(SKIN_VERSION_KEY, version);
    log('workbench.html 被更新覆盖，已自动重新注入皮肤（重载窗口后生效）。', '皮肤');
    void vscode.window
      .showInformationMessage('已自动恢复 B 站皮肤注入，重载窗口后执行「开启」即可显示。', '重载窗口')
      .then((choice) => {
        if (choice) {
          void vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      });
  } catch (error) {
    // 权限不足等情况下静默失败，避免每次启动都弹错；用户仍可手动“开启”。
    log(`自动恢复皮肤失败：${toMessage(error)}`, '错误');
  }
}

function isFresh(file: string, maxAgeMs: number): boolean {
  try {
    return Date.now() - fs.statSync(file).mtimeMs < maxAgeMs;
  } catch {
    return false;
  }
}

/**
 * API 令牌：除了存在 globalState，还在用户目录留一份，
 * 这样改扩展名/换 publisher 导致扩展 ID 变化时，令牌不会跟着变（否则 HUD 会 401）。
 */
function tokenFile(): string {
  return path.join(os.homedir(), '.vscode-bili-player.token');
}

async function getOrCreateToken(context: vscode.ExtensionContext): Promise<string> {
  const file = tokenFile();
  try {
    const fromFile = fs.readFileSync(file, 'utf8').trim();
    if (fromFile) {
      await context.globalState.update(TOKEN_KEY, fromFile);
      return fromFile;
    }
  } catch {
    // 还没有令牌文件
  }

  const existing = context.globalState.get<string>(TOKEN_KEY);
  const token = existing ?? randomBytes(24).toString('hex');
  try {
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  } catch {
    // 写不了就继续用 globalState
  }
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
    const assetsDir = path.dirname(install.htmlPath);
    const assetsMissing =
      !fs.existsSync(path.join(assetsDir, SKIN_JS)) || !fs.existsSync(path.join(assetsDir, SKIN_CSS));
    // 只有扩展版本变化或注入文件丢失时才重写 workbench.html。
    // 端口/令牌变化只改 config 文件：HUD 会自动扫描 17321-17330 并 401 自愈，
    // 而重写 workbench.html 会让 VS Code 主进程缓存的校验和失配，下次窗口误报“安装损坏”。
    const needsInject = !current || current.version !== config.version || assetsMissing;

    if (!needsInject) {
      writeSkinConfig(install, renderSkinConfig(config));
      return;
    }

    // 版本变化：重新注入一遍（同时换掉 ?v= 缓存键，避免渲染进程读到旧资源）
    applyPatch(install, readSkinAssets(context, config), {
      backupRoot: path.join(context.globalStorageUri.fsPath, 'workbench-backups'),
      cacheKey: String(Date.now()),
      log,
    });
    log('皮肤资源已更新（扩展版本变化），重载窗口后生效。', '皮肤');
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

/**
 * 找同一份 VS Code 安装下所有的 workbench.html。
 * Windows 1.9x 起安装目录会带版本号子目录（...\Microsoft VS Code\<hash>\resources\app），
 * 存在多份时，真正被加载的可能不是 vscode.env.appRoot 指向的那份。
 */
function findWorkbenchCopies(appRoot: string): { file: string; patched: boolean; mtime: Date; current: boolean }[] {
  const out: { file: string; patched: boolean; mtime: Date; current: boolean }[] = [];
  const currentHtml = (locateWorkbench(appRoot, vscode.version)?.htmlPath ?? '').toLowerCase();
  const resourcesApp =
    path.basename(appRoot).toLowerCase() === 'app' &&
    path.basename(path.dirname(appRoot)).toLowerCase() === 'resources';
  if (!resourcesApp) {
    return out;
  }
  // resources/app -> resources -> <hash> -> Microsoft VS Code
  const installRoot = path.dirname(path.dirname(path.dirname(appRoot)));

  /** 候选 app 根目录：安装根、每个版本子目录、以及当前 appRoot */
  const appRoots = new Set<string>([appRoot]);
  appRoots.add(path.join(installRoot, 'resources', 'app'));
  try {
    for (const entry of fs.readdirSync(installRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const base = path.join(installRoot, entry.name);
      appRoots.add(path.join(base, 'resources', 'app'));
      appRoots.add(base);
    }
  } catch {
    // 读不了安装根目录就只查 appRoot
  }

  const relatives = [
    'out/vs/code/electron-browser/workbench/workbench.html',
    'out/vs/code/electron-sandbox/workbench/workbench.html',
  ];
  const seen = new Set<string>();
  for (const root of appRoots) {
    for (const relative of relatives) {
      const file = path.join(root, ...relative.split('/'));
      const key = file.toLowerCase();
      if (seen.has(key) || !fs.existsSync(file)) {
        continue;
      }
      seen.add(key);
      try {
        const stat = fs.statSync(file);
        const html = fs.readFileSync(file, 'utf8');
        out.push({
          file,
          patched: html.includes('bilibili-skin:body:start'),
          mtime: stat.mtime,
          current: key === currentHtml,
        });
      } catch {
        // 读不了就跳过
      }
    }
  }
  return out;
}

/**
 * 诊断：把「注入有没有生效、HUD 有没有连上来」一次列清楚。
 * Windows 上没法直接看渲染进程，出问题时让用户跑这个命令即可定位。
 */
async function runDiagnose(context: vscode.ExtensionContext): Promise<void> {
  const lines: string[] = [];
  const push = (label: string, value: string) => lines.push(`${label}：${value}`);

  push('VS Code', `${vscode.version}（${process.platform} ${process.arch}）`);
  push('扩展版本', String(context.extension.packageJSON.version ?? '?'));

  const install = locateWorkbench(vscode.env.appRoot, vscode.version);
  if (!install) {
    push('workbench.html', '未找到（可能是便携版/远程窗口）');
  } else {
    const patched = isPatched(install);
    push('workbench.html', install.htmlPath);
    push('已注入', patched ? '是' : '否');
    const assetsDir = path.dirname(install.htmlPath);
    for (const file of [SKIN_JS, SKIN_CSS, SKIN_CONFIG]) {
      const target = path.join(assetsDir, file);
      try {
        const size = fs.statSync(target).size;
        push(`  ${file}`, size >= 1024 ? `${Math.round(size / 1024)} KB（${size} B）` : `${size} B`);
      } catch {
        push(`  ${file}`, '缺失');
      }
    }
    // workbench.html 里引用到的资源是否都存在（查“注入进去了但文件对不上”）
    try {
      const html = fs.readFileSync(install.htmlPath, 'utf8');
      const refs = Array.from(html.matchAll(/(?:src|href)="\.\/([^"?#]+)/g)).map((match) => match[1]);
      const skinRefs = refs.filter((ref) => ref.includes('bilibili-skin'));
      push(
        'HTML 引用',
        skinRefs.length
          ? skinRefs
              .map((ref) => `${ref}${fs.existsSync(path.join(assetsDir, ref)) ? '✓' : '✗'}`)
              .join(' / ')
          : '没有引用（注入片段缺失）',
      );
      const block = html.match(/<!-- bilibili-skin:(?:head|body):start -->[\s\S]*?<!-- bilibili-skin:(?:head|body):end -->/g);
      if (block) {
        push('注入片段', block.join(' ').replace(/\s+/g, ' ').slice(0, 400));
      }
    } catch {
      push('HTML 引用', '读取 workbench.html 失败');
    }
    try {
      fs.accessSync(assetsDir, fs.constants.W_OK);
      push('安装目录可写', '是');
    } catch {
      push('安装目录可写', '否（需要管理员权限或用户级安装）');
    }
    const config = readSkinConfigFile(install);
    push('注入配置', config ? `端口 ${config.port} / 版本 ${config.version}` : '读不到');

    // 同一安装下可能有多份 workbench.html，加载的不一定是 appRoot 这份
    const copies = findWorkbenchCopies(vscode.env.appRoot);
    if (copies.length > 1) {
      push('安装内 workbench.html', `共 ${copies.length} 份`);
      for (const copy of copies) {
        push(
          `  ${copy.current ? '←当前' : '     '} ${copy.file.replace(vscode.env.appRoot, '…')}`,
          `${copy.patched ? '已注入' : '未注入'} / ${copy.mtime.toLocaleString()}`,
        );
      }
    } else {
      push('安装内 workbench.html', copies.length === 1 ? '只有 1 份' : '扫描不到');
    }
  }

  if (services) {
    const started = await services.catch(() => undefined);
    if (started) {
      push('本地 API', `http://127.0.0.1:${started.port}`);
      const state = await started.state.snapshot(false);
      push('当前窗口状态', `visible=${state.visible} enabled=${state.enabled}`);
      push('HUD 探测（health）', hudStats.healthAt ? new Date(hudStats.healthAt).toLocaleTimeString() : '从未');
      push('HUD 已连接（state）', hudStats.stateAt ? new Date(hudStats.stateAt).toLocaleTimeString() : '从未');
      if (hudStats.lastFailure) {
        push('最近的失败请求', hudStats.lastFailure);
      }
    }
  } else {
    push('本地 API', '尚未启动');
  }

  const owner = context.globalState.get<WindowOwner>(OWNER_KEY);
  push('窗口占用', owner ? `端口 ${owner.port} / 会话 ${owner.session.slice(0, 6)}` : '无');
  push('本窗口会话', SESSION_ID.slice(0, 6));

  const text = lines.join('\n');
  log(`诊断报告\n${text}`, '诊断');
  output.show(true);

  const copy = await vscode.window.showInformationMessage(
    '诊断信息已输出到「Bilibili 皮肤」面板',
    { modal: false, detail: text.slice(0, 900) },
    '复制',
  );
  if (copy === '复制') {
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage('诊断信息已复制');
  }
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

    // 同一时间只允许一个窗口开着：已经在别的窗口开着就直接拒绝，
    // 否则会出现两个窗口同时播放、关掉一个另一个还在的情况。
    const owner = context.globalState.get<WindowOwner>(OWNER_KEY);
    if (owner && owner.port !== started.port && (await isOwnerAlive(owner, started.port))) {
      log(`拒绝开启：已被端口 ${owner.port}（会话 ${owner.session.slice(0, 6)}）占用`, '皮肤');
      void vscode.window.showWarningMessage(
        '另一个 VS Code 窗口已经开启了 bili-in-code，请先在那个窗口执行「关闭（还原工作台）」再开启。',
      );
      return;
    }

    await context.globalState.update(OWNER_KEY, {
      port: started.port,
      session: SESSION_ID,
      at: Date.now(),
    } satisfies WindowOwner);
    await context.globalState.update(ENABLED_KEY, true);
    await started.state.patch({ visible: true });
    log(`已开启（端口 ${started.port}，会话 ${SESSION_ID.slice(0, 6)}）`, '皮肤');
    void vscode.window.showInformationMessage('B站皮肤已开启：右下角 HUD 可播放视频（若没出现请重载窗口）。');
  } catch (error) {
    reportError(error);
  }
}

/**
 * 当前窗口的特征串：工作区名 + 当前文件名。
 * 渲染进程里对应的就是 document.title 里那几段，用来把 HUD 绑回本窗口的 API。
 */
function windowHint(): string {
  const parts: string[] = [];
  const workspaceName = vscode.workspace.name;
  if (workspaceName) {
    parts.push(workspaceName);
  }
  const file = vscode.window.activeTextEditor?.document.fileName;
  if (file) {
    parts.push(path.basename(file));
    parts.push(path.basename(file, path.extname(file)));
  }
  return Array.from(new Set(parts.filter(Boolean))).join('|');
}

/**
 * 占用记录还活着吗？
 * - 端口会被复用，所以“自己端口 + 比本次启动更早”的记录一定是上个会话留下的
 * - 其它端口就问一下 /api/health，窗口关了自然就探不到
 */
async function isOwnerAlive(owner: WindowOwner, myPort: number): Promise<boolean> {
  if (!owner || !owner.port) {
    return false;
  }
  // 端口会被复用：只有“同一个扩展宿主会话”才算还是这个窗口开着。
  if (owner.port === myPort) {
    return owner.session === SESSION_ID;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`http://127.0.0.1:${owner.port}/api/health`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return false;
    }
    const health = (await response.json()) as {
      ok?: boolean;
      apiVersion?: number;
      sessionId?: string;
    };
    // 端口可能被别的程序、或者上一个会话的另一个窗口占着：
    // 必须 ok + apiVersion + 会话号都对上，才算“占用者还开着”。
    return (
      health.ok === true &&
      (health.apiVersion ?? 0) >= 2 &&
      Boolean(owner.session) &&
      health.sessionId === owner.session
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 关闭（还原）：移除注入、恢复 CSP 与校验和。 */
async function runDisable(context: vscode.ExtensionContext): Promise<void> {
  await runRestore(context);
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
    // enabled 先写：applyPatch 在 Windows 上要写几百 KB，期间 HUD 轮询不能看到“半开”状态
    await context.globalState.update(ENABLED_KEY, true);
    await context.globalState.update(SHOW_ONCE_KEY, true);
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

async function runRestore(context: vscode.ExtensionContext): Promise<void> {
  try {
    const install = locateWorkbench(vscode.env.appRoot, vscode.version);
    if (!install) {
      throw new Error('未找到 VS Code 的 workbench.html');
    }

    /** 关掉全局开关：所有窗口的 HUD 下一次轮询（2s 内）都会自己收起来并暂停。 */
    const closeEverywhere = async (): Promise<void> => {
      await context.globalState.update(ENABLED_KEY, false);
      await context.globalState.update(SHOW_ONCE_KEY, false);
      await context.globalState.update(SKIN_VERSION_KEY, undefined);
      // 释放窗口占用，别的窗口才能再开
      await context.globalState.update(OWNER_KEY, undefined);
      // 本窗口立刻收掉；其它窗口靠 enabled:false 自己收（它们的 exthost 是独立实例）
      const started = await services?.catch(() => undefined);
      await started?.state.patch({ visible: false });
    };

    if (!isPatched(install)) {
      // 工作台已经是原始文件（或者被别的窗口还原过）：也要把播放器收掉，
      // 否则会出现“提示当前没有应用皮肤，但播放器还在播”。
      await closeEverywhere();
      void vscode.window.showInformationMessage(
        'B 站皮肤已关闭（工作台当前是原始文件，也不会再随 VS Code 升级自动恢复）。',
      );
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

    await closeEverywhere();
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

type LogTag = '启动' | '皮肤' | '播放' | '弹幕' | '客户端' | '错误' | '诊断';

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
