import * as vscode from 'vscode';
import { buildEmbedUrl, describeVideo, type VideoRef } from '../bilibili/parse';
import type { BilibiliPlayerSettings } from '../config';

let currentPanel: vscode.WebviewPanel | undefined;

/**
 * 安全模式：在编辑器旁边打开一个 Webview，内嵌 B 站官方播放器。
 * 不会修改 VS Code 安装目录，作为皮肤模式不可用时的兜底方案。
 */
export function openPlayerPanel(ref: VideoRef, settings: BilibiliPlayerSettings): void {
  const embedUrl = buildEmbedUrl(ref, {
    autoplay: settings.autoplay,
    quality: settings.quality,
    page: ref.page,
    startSeconds: ref.startSeconds,
  });
  const title = `B站 · ${describeVideo(ref)}`;

  if (currentPanel) {
    currentPanel.title = title;
    currentPanel.webview.html = renderHtml(title, embedUrl);
    currentPanel.reveal(vscode.ViewColumn.Beside, true);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'bilibiliPlayerPanel',
    title,
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    {
      enableScripts: false,
      retainContextWhenHidden: true,
    },
  );

  panel.webview.html = renderHtml(title, embedUrl);
  panel.onDidDispose(() => {
    if (currentPanel === panel) {
      currentPanel = undefined;
    }
  });
  currentPanel = panel;
}

function renderHtml(title: string, embedUrl: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; frame-src https://player.bilibili.com https://www.bilibili.com;"
  />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      background: #0b0b0f;
      color: #d7d7e0;
      font-family: var(--vscode-font-family, system-ui, sans-serif);
      overflow: hidden;
    }
    .layout {
      display: flex;
      flex-direction: column;
      height: 100%;
    }
    .frame {
      flex: 1 1 auto;
      border: 0;
      width: 100%;
      min-height: 0;
      background: #000;
    }
    .footer {
      flex: 0 0 auto;
      display: flex;
      gap: 12px;
      align-items: center;
      justify-content: space-between;
      padding: 6px 12px;
      font-size: 12px;
      color: #8a8aa0;
      border-top: 1px solid #1e1e2a;
    }
    .footer a { color: #7aa2ff; text-decoration: none; }
  </style>
</head>
<body>
  <div class="layout">
    <iframe
      class="frame"
      src="${escapeHtml(embedUrl)}"
      title="${escapeHtml(title)}"
      allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
      allowfullscreen
      referrerpolicy="origin"
    ></iframe>
    <div class="footer">
      <span>安全模式 · 未修改工作台文件 · 清晰度取决于 B 站账号</span>
      <a href="https://www.bilibili.com/" target="_blank" rel="noreferrer">在浏览器打开 B 站</a>
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
