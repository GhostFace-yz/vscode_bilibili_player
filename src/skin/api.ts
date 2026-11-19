import { PORT_RANGE } from '../shared/types';
import type {
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
export class SkinApi {
  private preferredPort: number;
  private readonly verifiedPorts = new Set<number>();

  constructor(private readonly config: SkinConfig) {
    this.preferredPort = config.port;
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

  diagnostics(payload: unknown): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>('/api/diagnostics', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
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
    const ports = [this.preferredPort, ...PORT_RANGE.filter((port) => port !== this.preferredPort)];
    let lastError: unknown;

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
        if (status === 401 || status === 404) {
          this.verifiedPorts.delete(port);
          continue;
        }
        if (status !== undefined) {
          throw error;
        }
      }
    }

    throw new Error(
      lastError instanceof Error ? `本地服务未响应：${lastError.message}` : '本地服务未启动',
    );
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
