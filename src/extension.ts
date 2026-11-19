import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { BiliAuth, type SecretStore } from './bilibili/auth';
import { parseVideoInput, describeVideo } from './bilibili/parse';
import { getPlayInfo } from './bilibili/playurl';
import { getSettings } from './config';
import { findAudioTranscoder } from './server/audioTranscode';
import { startApiServer, type ApiServerHandle } from './server/apiServer';
import { renderSkinConfig, type SkinConfig } from './shared/types';
import { ExtensionState } from './state';
import { findChecksumMismatches, fixChecksums } from './workbench/checksums';
import { locateWorkbench } from './workbench/locate';
import { applyPatch, isPatched, restorePatch, writeSkinConfig } from './workbench/patcher';
import { openPlayerPanel } from './webview/playerPanel';

const TOKEN_KEY = 'bilibiliPlayer.apiToken';
const SKIN_VERSION_KEY = 'bilibiliPlayer.skinVersion';

interface Services {
  auth: BiliAuth;
  state: ExtensionState;
  server: ApiServerHandle;
  token: string;
}

let output: vscode.OutputChannel;
let statusBar: vscode.StatusBarItem;
let services: Promise<Services> | undefined;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Bilibili 皮肤');
  context.subscriptions.push(output);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.text = '$(device-camera-video) B站';
  statusBar.tooltip = 'B站视频皮肤：点击显示/隐藏（Cmd/Ctrl+Alt+B）';
  statusBar.command = 'bilibiliPlayer.toggle';
  statusBar.show();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('bilibiliPlayer.play', () => runPlay(context)),
    vscode.commands.registerCommand('bilibiliPlayer.openPlayerPanel', () => runOpenPanel(context)),
    vscode.commands.registerCommand('bilibiliPlayer.toggle', () => runToggle()),
    vscode.commands.registerCommand('bilibiliPlayer.login', () => runLogin()),
    vscode.commands.registerCommand('bilibiliPlayer.applySkin', () => runApply(context)),
    vscode.commands.registerCommand('bilibiliPlayer.restoreSkin', () => runRestore()),
    vscode.commands.registerCommand('bilibiliPlayer.fixChecksums', () => runFixChecksums()),
    vscode.commands.registerCommand('bilibiliPlayer.showLog', () => output.show(true)),
  );

  services = initServices(context).catch((error: unknown) => {
    log(`初始化失败：${toMessage(error)}`);
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
  } catch {
    // 目录已存在或不可写，下面 append 失败会静默忽略
  }

  let apiPort = 0;
  const server = await startApiServer({
    token,
    version,
    cacheDir,
    getState: () => state.snapshot(),
    patchState: (patch) => state.patch(patch),
    getPlayInfo: async (ref, qn) => {
      const info = await getPlayInfo(auth.client(), ref, qn);
      if (!apiPort) {
        return info;
      }
      // 音轨要在扩展宿主里转成 MP3/WAV：VS Code 的 libffmpeg 没有 AAC 解码器。
      const transcoded = (audioUrl: string) =>
        `http://127.0.0.1:${apiPort}/api/audio/transcoded?url=${encodeURIComponent(audioUrl)}&token=${encodeURIComponent(token)}`;
      return {
        ...info,
        audioUrl: info.audioUrl ? transcoded(info.audioUrl) : undefined,
        audioBackupUrls: info.audioBackupUrls?.map(transcoded),
      };
    },
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
      } catch {
        // 磁盘不可写时只保留输出通道
      }
      log(
        `[client:${entry.level ?? 'info'}] ${entry.message ?? ''}${
          entry.data === undefined ? '' : ` ${stringifyForLog(entry.data)}`
        }`,
      );
    },
  });

  apiPort = server.port;
  log(`本地 API 已启动：http://127.0.0.1:${server.port}`);
  log(`客户端日志：${clientLogPath}`);
  log(`音频转码器：${findAudioTranscoder()?.name ?? '未找到（无法播放 AAC 音轨）'}`);

  const started: Services = { auth, state, server, token };
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
  log(`皮肤版本 ${lastVersion ?? '未知'} → ${version}，已重新显示。`);
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

  try {
    writeSkinConfig(install, renderSkinConfig(skinConfigFor(context, started)));
    log('已同步皮肤配置（端口/令牌）。');
  } catch (error) {
    log(`同步皮肤配置失败：${toMessage(error)}`);
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
    statusBar.tooltip = `B站视频皮肤 · 已登录：${started.auth.user.name} · Cmd/Ctrl+Alt+B 显示/隐藏`;
  } else {
    statusBar.text = '$(device-camera-video) B站';
    statusBar.tooltip = 'B站视频皮肤 · 未登录（可播放 480P/720P） · Cmd/Ctrl+Alt+B 显示/隐藏';
  }
}

async function runPlay(context: vscode.ExtensionContext): Promise<void> {
  const settings = getSettings();
  const input = await vscode.window.showInputBox({
    title: '播放 B 站视频',
    prompt: '输入 BV 号、av 号或视频链接，例如 BV1GJ411x7h7',
    value: settings.defaultVideo,
    ignoreFocusOut: true,
    validateInput: (value) => (parseVideoInput(value) ? undefined : '无法识别的 BV 号 / av 号 / 链接'),
  });
  if (!input) {
    return;
  }

  const ref = parseVideoInput(input);
  if (!ref) {
    return;
  }

  try {
    const started = await requireServices();
    await started.state.patch({
      video: { bvid: ref.bvid, aid: ref.aid, page: ref.page },
      visible: true,
    });
    await context.globalState.update('bilibiliPlayer.lastVideo', input.trim());

    const install = locateWorkbench(vscode.env.appRoot, vscode.version);
    if (install && isPatched(install)) {
      void vscode.window.showInformationMessage(`已在皮肤中播放：${describeVideo(ref)}`);
    } else {
      openPlayerPanel(ref, getSettings());
      void vscode.window
        .showInformationMessage('皮肤模式尚未应用，已使用安全模式播放。', '应用皮肤')
        .then((choice) => {
          if (choice === '应用皮肤') {
            void vscode.commands.executeCommand('bilibiliPlayer.applySkin');
          }
        });
    }
  } catch (error) {
    reportError(error);
  }
}

async function runOpenPanel(context: vscode.ExtensionContext): Promise<void> {
  try {
    const started = await requireServices();
    const settings = getSettings();
    const source = settings.defaultVideo || context.globalState.get<string>('bilibiliPlayer.lastVideo') || '';
    const ref = source ? parseVideoInput(source) : undefined;

    if (!ref) {
      await vscode.commands.executeCommand('bilibiliPlayer.play');
      return;
    }

    await started.state.patch({
      video: { bvid: ref.bvid, aid: ref.aid, page: ref.page },
      visible: true,
    });
    openPlayerPanel(ref, settings);
  } catch (error) {
    reportError(error);
  }
}

async function runToggle(): Promise<void> {
  try {
    const started = await requireServices();
    const install = locateWorkbench(vscode.env.appRoot, vscode.version);

    if (!install || !isPatched(install)) {
      const choice = await vscode.window.showInformationMessage(
        '皮肤模式尚未应用：需要把播放器注入工作台背景层。',
        '应用皮肤',
      );
      if (choice) {
        await vscode.commands.executeCommand('bilibiliPlayer.applySkin');
      }
      return;
    }

    const current = await started.state.snapshot(false);
    await started.state.patch({ visible: !current.visible });
  } catch (error) {
    reportError(error);
  }
}

async function runLogin(): Promise<void> {
  try {
    const started = await requireServices();
    const install = locateWorkbench(vscode.env.appRoot, vscode.version);

    if (!install || !isPatched(install)) {
      const choice = await vscode.window.showInformationMessage(
        '扫码登录在皮肤 HUD 中进行；请先应用皮肤模式。',
        '应用皮肤',
      );
      if (choice) {
        await vscode.commands.executeCommand('bilibiliPlayer.applySkin');
      }
      return;
    }

    await started.state.patch({ visible: true, openLogin: true });
  } catch (error) {
    reportError(error);
  }
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
    log(`皮肤已应用到 ${install.htmlPath}`);

    const mismatches = findChecksumMismatches(install.appRoot, install.productJsonPath);
    if (mismatches.length > 0) {
      log(`检测到 ${mismatches.length} 个文件校验和不一致（可能来自其它工具的修改）。`);
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
        log(`已修复 ${fixed.length} 个校验和。`);
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
    log('已还原工作台。');

    if (answer === '还原并重载') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    } else {
      void vscode.window.showInformationMessage('已还原，重载窗口后生效。');
    }
  } catch (error) {
    reportError(error);
  }
}

async function runFixChecksums(): Promise<void> {
  try {
    const install = locateWorkbench(vscode.env.appRoot, vscode.version);
    if (!install) {
      throw new Error('未找到 VS Code 工作台文件');
    }

    const mismatches = findChecksumMismatches(install.appRoot, install.productJsonPath);
    if (mismatches.length === 0) {
      void vscode.window.showInformationMessage('所有校验和均匹配，无需修复。');
      return;
    }

    const list = mismatches
      .slice(0, 8)
      .map((mismatch) => `• ${mismatch.key}`)
      .join('\n');
    const detail =
      `${list}${mismatches.length > 8 ? `\n… 共 ${mismatches.length} 个文件` : ''}\n\n` +
      '这通常来自其它工具对 VS Code 安装目录的修改。修复会以当前文件为准重算 product.json 中的校验和，' +
      '只用于消除“安装已损坏”提示，不会改动任何代码文件；VS Code 升级后可能需要重新修复。';

    const answer = await vscode.window.showWarningMessage(
      `检测到 ${mismatches.length} 个文件与 product.json 校验和不一致`,
      { modal: true, detail },
      '修复并重载',
      '仅修复',
    );
    if (!answer) {
      return;
    }

    const fixed = fixChecksums(install.appRoot, install.productJsonPath, log);
    log(`已修复 ${fixed.length} 个校验和。`);

    if (answer === '修复并重载') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    } else {
      void vscode.window.showInformationMessage(`已修复 ${fixed.length} 个文件的校验和，重载窗口后生效。`);
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

function log(message: string): void {
  try {
    output?.appendLine(`[${new Date().toISOString()}] ${message}`);
  } catch {
    // 重载窗口时输出通道可能已关闭，不能让它中断注入/还原流程
  }
}

function reportError(error: unknown): void {
  const message = toMessage(error);
  log(`错误：${message}`);
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
