import { createRoot } from 'react-dom/client';
import sonnerStyles from 'sonner/dist/styles.css';
import type { SkinConfig } from '../shared/types';
import { SkinApi } from './api';
import { Hud } from './Hud';

/** 等工作台里的本地服务起来的最长时间（扩展宿主是 onStartupFinished，Windows 上可能更慢）。 */
const CONNECT_TIMEOUT_MS = 60_000;
/** 一直等不到本地服务时的后台重试间隔 / 总时长 */
const RETRY_INTERVAL_MS = 5000;
const RETRY_TOTAL_MS = 5 * 60_000;

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
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
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
    } else if (attempts % 10 === 1) {
      console.warn('[bilibili-skin] 本地服务还没起来，继续等待…（第', attempts, '次探测）');
    }
    await sleep(500);
  }

  if (!(await api.probe())) {
    console.warn('[bilibili-skin] 连不上扩展宿主的本地服务：检查扩展是否已启用、端口 17321-17330 是否被占用');
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

/** 把注入留下的节点/类清掉（不删样式，方便之后还能重新挂载）。 */
function removeHosts(): void {
  try {
    document.body.classList.remove('bili-skin-on');
    document.getElementById('bili-skin-video-host')?.remove();
    document.getElementById('bili-skin-hud')?.remove();
  } catch {
    // 清理失败不影响编辑器
  }
}

/** 探测失败：把可能残留的样式/节点清干净，让编辑区恢复成普通 VS Code。 */
function teardown(): void {
  try {
    removeHosts();
    document.querySelectorAll('link[href*="bilibili-skin.css"]').forEach((node) => node.remove());
    document.documentElement.dataset.biliSkin = 'offline';
  } catch {
    // 清理失败不影响编辑器
  }
}

function mount(api: SkinApi): void {
  ensureSonnerStyles();
  removeHosts();

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
    // 服务可能只是起得慢（Windows 首次启动/杀毒扫描）：先清掉节点，后台继续等
    removeHosts();
    retryMount(config);
    return;
  }

  console.info('[bilibili-skin] 已连接本地服务，端口', api.port);
  mount(api);
}

/** 后台继续等待本地服务：起来就挂载，等满 5 分钟再彻底放弃。 */
function retryMount(config: SkinConfig): void {
  const deadline = Date.now() + RETRY_TOTAL_MS;
  const api = new SkinApi(config);
  const timer = window.setInterval(() => {
    void api.probe().then((port) => {
      if (port !== null) {
        window.clearInterval(timer);
        api.log({ level: 'info', message: 'hud bound (late)', data: api.bindInfo });
        console.info('[bilibili-skin] 延迟连接成功，端口', port);
        mount(api);
        return;
      }
      if (Date.now() > deadline) {
        window.clearInterval(timer);
        teardown();
        console.warn('[bilibili-skin] 放弃等待本地服务，已移除注入的 UI');
      }
    });
  }, RETRY_INTERVAL_MS);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void boot(), { once: true });
} else {
  void boot();
}
