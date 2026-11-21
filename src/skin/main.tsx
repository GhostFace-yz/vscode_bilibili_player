import { createRoot } from 'react-dom/client';
import sonnerStyles from 'sonner/dist/styles.css';
import type { SkinConfig } from '../shared/types';
import { SkinApi } from './api';
import { Hud } from './Hud';

/** 等工作台里的本地服务起来的最长时间（扩展宿主是 onStartupFinished，可能比页面晚几秒）。 */
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * VS Code 把主题变量（--vscode-*）定义在 .monaco-workbench 上，而不是 body。
 * HUD、视频层和 Radix Portal 必须挂到 workbench 内部，才能继承当前主题颜色。
 */
function mountPoint(): HTMLElement {
  return document.querySelector<HTMLElement>('.monaco-workbench') ?? document.body;
}

function ensureSonnerStyles(): void {
  if (document.getElementById('bili-sonner-styles')) {
    return;
  }
  const style = document.createElement('style');
  style.id = 'bili-sonner-styles';
  style.textContent = sonnerStyles;
  document.head.append(style);
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/**
 * 探测扩展宿主的本地 API。
 * 卸载/禁用扩展后 workbench.html 里的注入不会自动消失，如果直接挂载 HUD，
 * 就会出现一个连不上服务、只会显示“本地服务未启动”的空设置面板。
 */
async function waitForApi(config: SkinConfig): Promise<SkinApi | null> {
  const api = new SkinApi(config);
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    const port = await api.probe();
    if (port !== null) {
      // 多窗口时端口可能连到别的窗口，把绑定结果记进日志方便排查
      api.log({ level: 'info', message: 'hud bound', data: api.bindInfo });
      return api;
    }
    attempt += 1;
    await sleep(attempt <= 6 ? 250 : 1000);
  }
  return null;
}

/** 探测失败：把可能残留的样式/节点清干净，让编辑区恢复成普通 VS Code。 */
function teardown(): void {
  try {
    document.body.classList.remove('bili-skin-on');
    document.getElementById('bili-skin-video-host')?.remove();
    document.getElementById('bili-skin-hud')?.remove();
    document.querySelectorAll('link[href*="bilibili-skin.css"]').forEach((node) => node.remove());
    document.documentElement.dataset.biliSkin = 'offline';
  } catch {
    // 清理失败不影响编辑器
  }
}

async function boot(): Promise<void> {
  const config = window.__BILI_SKIN_CONFIG__;
  if (!config) {
    console.warn('[bilibili-skin] missing window.__BILI_SKIN_CONFIG__');
    return;
  }
  if (window.__BILI_SKIN_MOUNTED__) {
    return;
  }
  window.__BILI_SKIN_MOUNTED__ = true;

  const api = await waitForApi(config);
  if (!api) {
    teardown();
    return;
  }

  ensureSonnerStyles();

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

  // 用探测到的端口覆盖 config.port：HUD 必须连自己这个窗口的服务
  createRoot(hudHost).render(<Hud config={{ ...config, port: api.port }} videoHost={videoHost} />);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void boot(), { once: true });
} else {
  void boot();
}
