import * as vscode from 'vscode';
import { describeVideo, parseVideoInput, type VideoRef } from './bilibili/parse';
import { getSettings } from './config';
import { openPlayerPanel } from './webview/playerPanel';

const LAST_VIDEO_KEY = 'bilibiliPlayer.lastVideo';

let statusBar: vscode.StatusBarItem | undefined;

export function activate(context: vscode.ExtensionContext): void {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.text = '$(device-camera-video) B站';
  statusBar.tooltip = 'Bilibili 视频皮肤：打开播放器';
  statusBar.command = 'bilibiliPlayer.openPlayerPanel';
  statusBar.show();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('bilibiliPlayer.play', () => playCommand(context)),
    vscode.commands.registerCommand('bilibiliPlayer.openPlayerPanel', () => openPanelCommand(context)),
  );
}

export function deactivate(): void {
  statusBar?.dispose();
  statusBar = undefined;
}

async function playCommand(context: vscode.ExtensionContext): Promise<void> {
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

  await context.globalState.update(LAST_VIDEO_KEY, input.trim());
  openPlayerPanel(ref, settings);
  if (statusBar) {
    statusBar.tooltip = `正在播放：${describeVideo(ref)}`;
  }
}

async function openPanelCommand(context: vscode.ExtensionContext): Promise<void> {
  const settings = getSettings();
  const source = settings.defaultVideo || context.globalState.get<string>(LAST_VIDEO_KEY) || '';
  const ref: VideoRef | undefined = source ? parseVideoInput(source) : undefined;

  if (!ref) {
    await vscode.commands.executeCommand('bilibiliPlayer.play');
    return;
  }

  openPlayerPanel(ref, settings);
}
