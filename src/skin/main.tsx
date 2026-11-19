import { createRoot } from 'react-dom/client';
import { Hud } from './Hud';

/**
 * VS Code 把主题变量（--vscode-*）定义在 .monaco-workbench 上，而不是 body。
 * HUD、视频层和 Radix Portal 必须挂到 workbench 内部，才能继承当前主题颜色。
 */
function mountPoint(): HTMLElement {
  return document.querySelector<HTMLElement>('.monaco-workbench') ?? document.body;
}

function boot(): void {
  const config = window.__BILI_SKIN_CONFIG__;
  if (!config) {
    console.warn('[bilibili-skin] missing window.__BILI_SKIN_CONFIG__');
    return;
  }
  if (window.__BILI_SKIN_MOUNTED__) {
    return;
  }
  window.__BILI_SKIN_MOUNTED__ = true;

  const videoHost = document.createElement('div');
  videoHost.id = 'bili-skin-video-host';
  const hudHost = document.createElement('div');
  hudHost.id = 'bili-skin-hud';

  const root = mountPoint();
  root.append(videoHost, hudHost);

  // 极少数启动时序下 workbench 还没挂好：先挂 body，出现后再搬进去。
  if (root === document.body) {
    const observer = new MutationObserver(() => {
      const workbench = document.querySelector<HTMLElement>('.monaco-workbench');
      if (workbench) {
        workbench.append(videoHost, hudHost);
        observer.disconnect();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.setTimeout(() => observer.disconnect(), 10_000);
  }

  createRoot(hudHost).render(<Hud config={config} videoHost={videoHost} />);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
