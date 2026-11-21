import { PORT_RANGE } from '../shared/types';
import type {
  DanmakuItem,
  LiveDanmakuItem,
  LiveRoomInfo,
  LoginPoll,
  LoginQr,
  PlayInfo,
  SkinConfig,
  SkinState,
  StatePatch,
  VideoRef,
} from '../shared/types';

interface ApiError extends Error {
  status?: number;
}

/**
 * 访问扩展宿主里的本地 API。
 * 多窗口/端口变化时自动在 17321-17330 之间寻找可用实例。
 */
export interface ContentAspectResult {
  ok: boolean;
  width?: number;
  height?: number;
  aspect?: number;
  cropped?: boolean;
}

export interface HealthInfo {
  ok: boolean;
  version?: string;
  apiVersion?: number;
  port?: number;
  windowHint?: string;
  audioTranscoder?: string | null;
  ffmpeg?: boolean;
  platform?: string;
}

export class SkinApi {
  private preferredPort: number;
  private readonly verifiedPorts = new Set<number>();
  private bindReport: { title: string; port: number; matched: boolean; candidates: unknown } | null = null;

  constructor(private config: SkinConfig) {
    this.preferredPort = config.port;
  }

  /** 直接读 /api/health（不需要额外校验），用于提示 ffmpeg 缺失等环境问题。 */
  async health(): Promise<HealthInfo | null> {
    try {
      const response = await fetch(`http://127.0.0.1:${this.preferredPort}/api/health`, {
        cache: 'no-store',
      });
      if (!response.ok) {
        return null;
      }
      return (await response.json()) as HealthInfo;
    } catch {
      return null;
    }
  }

  /**
   * 只探测本地服务在不在（/api/health，无副作用）。
   * HUD 挂载前用：卸载/禁用扩展后 workbench 里的注入还在，探测失败就不渲染。
   *
   * 多窗口时所有窗口共用同一份 bilibili-skin.config.js（谁最后激活就写谁的端口），
   * 新开的窗口经常拿到别的窗口的端口，结果“在一个窗口开启、另一个窗口亮起来”。
   * 这里用窗口标题把 HUD 绑回自己这个窗口的服务；标题对不上就退回原来的顺序。
   */
  async probe(): Promise<number | null> {
    const ports = [this.preferredPort, ...PORT_RANGE.filter((port) => port !== this.preferredPort)];
    const healthy: { port: number; hint: string }[] = [];
    for (const port of ports) {
      const info = await this.healthAt(port);
      if (info) {
        healthy.push({ port, hint: info.windowHint ?? '' });
      }
    }
    if (healthy.length === 0) {
      return null;
    }

    const title = (document.title ?? '').trim();
    let best: { port: number; hint: string; score: number } | undefined;
    for (const item of healthy) {
      const score = item.hint && title ? hintScore(item.hint, title) : 0;
      if (score > 0 && (!best || score > best.score)) {
        best = { ...item, score };
      }
    }
    this.preferredPort = (best ?? healthy[0]).port;
    this.bindReport = {
      title,
      port: this.preferredPort,
      matched: Boolean(best),
      candidates: healthy,
    };
    return this.preferredPort;
  }

  /** 当前绑定的端口（HUD 必须连自己这个窗口的服务）。 */
  get port(): number {
    return this.preferredPort;
  }

  /** 最近一次 probe 的绑定结果，用于排查多窗口连错端口。 */
  get bindInfo(): { title: string; port: number; matched: boolean; candidates: unknown } | null {
    return this.bindReport;
  }

  private async healthAt(port: number): Promise<HealthInfo | null> {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { cache: 'no-store' });
      if (!response.ok) {
        return null;
      }
      const data = (await response.json()) as HealthInfo & { apiVersion?: number };
      if (data.ok !== true || (data.apiVersion ?? 0) < 2) {
        return null;
      }
      this.verifiedPorts.add(port);
      return data;
    } catch {
      return null;
    }
  }

  state(): Promise<SkinState> {
    return this.request<SkinState>('/api/state');
  }

  patch(patch: StatePatch): Promise<SkinState> {
    return this.request<SkinState>('/api/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
  }

  play(ref: VideoRef, qn: number): Promise<PlayInfo> {
    const params = new URLSearchParams();
    if (ref.bvid) {
      params.set('bvid', ref.bvid);
    }
    if (ref.aid) {
      params.set('aid', ref.aid);
    }
    if (ref.page && ref.page > 0) {
      params.set('page', String(ref.page));
    }
    params.set('qn', String(qn));
    return this.request<PlayInfo>(`/api/play?${params.toString()}`);
  }

  /** 让扩展宿主用 ffmpeg 探测画面真实宽高比（去掉视频里烘焙的黑边）。 */
  contentAspect(url: string, key: string, duration: number): Promise<ContentAspectResult> {
    const params = new URLSearchParams({ url, key, duration: String(Math.round(duration)) });
    return this.request<ContentAspectResult>(`/api/content-aspect?${params.toString()}`);
  }

  /** 拉取整段弹幕（宿主按 cid 缓存）。 */
  danmaku(cid: number): Promise<{ ok: boolean; items: DanmakuItem[] }> {
    return this.request<{ ok: boolean; items: DanmakuItem[] }>(`/api/danmaku?cid=${cid}`);
  }

  /** 把到时间的弹幕交给宿主打印到输出面板；live 时按直播格式打印。 */
  emitDanmaku(items: DanmakuItem[], live = false): Promise<{ ok: boolean; count: number }> {
    return this.request<{ ok: boolean; count: number }>('/api/danmaku/emit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items, live }),
    });
  }

  /** 解析直播间链接/房间号，拿到开播状态和上游 HLS 地址。 */
  liveRoom(
    input: string,
    qn?: number,
  ): Promise<{ ok: boolean; room?: LiveRoomInfo; error?: string }> {
    const qnParam = qn ? `&qn=${qn}` : '';
    return this.request<{ ok: boolean; room?: LiveRoomInfo; error?: string }>(
      `/api/live/room?input=${encodeURIComponent(input)}${qnParam}`,
    );
  }

  liveDanmaku(roomId: number): Promise<{ ok: boolean; items: LiveDanmakuItem[] }> {
    return this.request<{ ok: boolean; items: LiveDanmakuItem[] }>(
      `/api/live/danmaku?room=${roomId}`,
    );
  }

  /** 直播走宿主的 ffmpeg 代理：HLS → fMP4（H.264 copy + MP3 音频）。 */
  liveStreamUrl(upstream: string, transcode: boolean): string {
    const params = new URLSearchParams({
      url: upstream,
      token: this.config.token,
      transcode: transcode ? '1' : '0',
    });
    return `http://127.0.0.1:${this.preferredPort}/api/live/stream?${params.toString()}`;
  }

  diagnostics(payload: unknown): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>('/api/diagnostics', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  /** 把渲染进程里的错误/媒体事件送到扩展宿主，落盘成日志。 */
  log(entry: { level?: 'info' | 'warn' | 'error'; message?: string; data?: unknown }): void {
    try {
      void fetch(`http://127.0.0.1:${this.preferredPort}/api/client-log`, {
        method: 'POST',
        cache: 'no-store',
        headers: {
          'content-type': 'application/json',
          'x-bili-token': this.config.token,
        },
        body: JSON.stringify({ ...entry, at: Date.now() }),
      }).catch(() => undefined);
    } catch {
      // 日志失败不能影响播放
    }
  }

  loginQr(): Promise<LoginQr> {
    return this.request<LoginQr>('/api/login/qr');
  }

  pollLogin(key: string): Promise<LoginPoll> {
    return this.request<LoginPoll>(`/api/login/poll?key=${encodeURIComponent(key)}`);
  }

  logout(): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>('/api/logout', { method: 'POST' });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    try {
      return await this.requestOnce<T>(path, init);
    } catch (error) {
      // 扩展换了 publisher/重装后会重新生成令牌，页面里还是旧配置：
      // 这里重新拉一次 bilibili-skin.config.js（带 cache buster），自愈，不用重载窗口。
      if ((error as ApiError).status !== 401) {
        throw error;
      }
      if (!(await this.refreshToken())) {
        throw error;
      }
      return this.requestOnce<T>(path, init);
    }
  }

  private async requestOnce<T>(path: string, init: RequestInit = {}): Promise<T> {
    const ports = [this.preferredPort, ...PORT_RANGE.filter((port) => port !== this.preferredPort)];
    let lastError: unknown;
    let authFailed = false;

    for (const port of ports) {
      if (!(await this.isCompatible(port))) {
        continue;
      }
      try {
        const data = await this.fetchJson<T>(port, path, init);
        this.preferredPort = port;
        return data;
      } catch (error) {
        lastError = error;
        const status = (error as ApiError).status;
        if (status === 401) {
          authFailed = true;
          this.verifiedPorts.delete(port);
          continue;
        }
        if (status === 404) {
          this.verifiedPorts.delete(port);
          continue;
        }
        if (status !== undefined) {
          throw error;
        }
      }
    }

    if (authFailed) {
      const error: ApiError = new Error('本地访问令牌已失效');
      error.status = 401;
      throw error;
    }

    throw new Error(
      lastError instanceof Error ? `本地服务未响应：${lastError.message}` : '本地服务未启动',
    );
  }

  /** 重新读取工作台目录里的配置（带 cache buster），拿到扩展最新写入的端口/令牌。 */
  private async refreshToken(): Promise<boolean> {
    try {
      const response = await fetch(`./bilibili-skin.config.js?t=${Date.now()}`, {
        cache: 'no-store',
      });
      if (!response.ok) {
        return false;
      }
      const text = await response.text();
      const match = /window\.__BILI_SKIN_CONFIG__\s*=\s*(\{[\s\S]*\});/.exec(text);
      if (!match) {
        return false;
      }
      const config = JSON.parse(match[1]) as SkinConfig;
      if (!config?.token) {
        return false;
      }
      this.config = { ...this.config, ...config };
      // 端口故意不跟着改：多窗口时这份 config 可能是别的窗口写的，
      // 跟着换就会连到另一个窗口的服务（那边开着就亮、关着就黑）。
      this.verifiedPorts.clear();
      return true;
    } catch {
      return false;
    }
  }

  /** 只连接 0.2+ 的本地 API，避免多窗口升级期间连到旧版服务。 */
  private async isCompatible(port: number): Promise<boolean> {
    if (this.verifiedPorts.has(port)) {
      return true;
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { cache: 'no-store' });
      if (!response.ok) {
        return false;
      }
      const data = (await response.json()) as { ok?: boolean; apiVersion?: number };
      if (data.ok === true && (data.apiVersion ?? 0) >= 2) {
        this.verifiedPorts.add(port);
        return true;
      }
    } catch {
      // 端口不可用
    }
    return false;
  }

  private async fetchJson<T>(port: number, path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      cache: 'no-store',
      headers: {
        'x-bili-token': this.config.token,
        ...((init.headers as Record<string, string> | undefined) ?? {}),
      },
    });

    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { error?: string };
        if (body.error) {
          message = body.error;
        }
      } catch {
        // 忽略非 JSON 错误体
      }
      const error: ApiError = new Error(message);
      error.status = response.status;
      throw error;
    }

    return (await response.json()) as T;
  }
}

/**
 * 用扩展宿主给的特征串（工作区名 / 文件名）和 document.title 对一下：
 * 命中几段就算几分，0 分表示这个端口不是本窗口。
 */
function hintScore(hint: string, title: string): number {
  return hint
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && title.includes(part)).length;
}
