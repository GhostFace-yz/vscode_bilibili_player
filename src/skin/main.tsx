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
  /** 已经探到“别人的”服务的时间：再等一会儿自己的扩展宿主起来 */
  let fallbackAt = 0;
  while (Date.now() < deadline) {
    if (await api.probe()) {
      if (api.bindInfo?.matched) {
        api.log({ level: 'info', message: 'hud bound', data: api.bindInfo });
        return api;
      }
      // 新开的窗口，页面比扩展宿主先起来：这时只能扫到别的窗口的服务。
      // 等 4s，等自己的服务出现后再绑定，别一上来就连到别人窗口。
      if (!fallbackAt) {
        fallbackAt = Date.now();
      } else if (Date.now() - fallbackAt > 4000) {
        break;
      }
    }
    await sleep(500);
  }

  if (!(await api.probe())) {
    return null;
  }
  api.log({ level: 'info', message: 'hud bound (fallback)', data: api.bindInfo });
  return api;
}

/**
 * 绑定到别的窗口时，隔几秒再看一眼：自己的服务起来后切回来。
 * （新窗口第一次加载几乎都会走到这里）
 */
function watchBinding(api: SkinApi): void {
  if (api.bindInfo?.matched) {
    return;
  }
  let tries = 0;
  const timer = window.setInterval(() => {
    tries += 1;
    void api.probe().then((port) => {
      if (port !== null && api.bindInfo?.matched) {
        api.log({ level: 'info', message: 'hud rebound', data: api.bindInfo });
        window.clearInterval(timer);
        return;
      }
      if (tries >= 12) {
        window.clearInterval(timer);
      }
    });
  }, 2500);
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

  // 直接把绑定好的 api 交给 HUD：后续重新绑定也能立刻生效
  watchBinding(api);
  createRoot(hudHost).render(<Hud api={api} videoHost={videoHost} />);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void boot(), { once: true });
} else {
  void boot();
}
