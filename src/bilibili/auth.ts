import QRCode from 'qrcode';
import { BiliClient, BILI_UA } from './client';
import { mergeCookies, parseSetCookies, serializeCookieJar, type CookieJar } from './cookies';
import type { BiliUser, LoginPoll, LoginQr } from '../shared/types';

const AUTH_SECRET_KEY = 'bilibiliPlayer.auth.v1';
const QR_TTL_MS = 3 * 60 * 1000;
const REFERER = 'https://www.bilibili.com/';

export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

interface StoredAuth {
  cookies: CookieJar;
  refreshToken?: string;
}

interface QrEntry {
  expiresAt: number;
}

interface QrGenerateData {
  url: string;
  qrcode_key: string;
}

interface QrPollData {
  code: number;
  message?: string;
  refresh_token?: string;
  url?: string;
}

/**
 * B 站扫码登录：生成二维码 → 轮询 → 保存 Cookie。
 * 只依赖 SecretStore 抽象，方便脱离 VS Code 单独测试。
 */
export class BiliAuth {
  private cookies: CookieJar = {};
  private refreshToken: string | undefined;
  private cachedUser: BiliUser | null = null;
  private revision = 0;
  private readonly pendingQr = new Map<string, QrEntry>();

  constructor(
    private readonly store: SecretStore,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  get user(): BiliUser | null {
    return this.cachedUser;
  }

  get loggedIn(): boolean {
    return this.cachedUser !== null;
  }

  get authRevision(): number {
    return this.revision;
  }

  jar(): CookieJar {
    return this.cookies;
  }

  client(): BiliClient {
    return new BiliClient(this.cookies);
  }

  async init(): Promise<void> {
    const raw = await this.store.get(AUTH_SECRET_KEY);
    if (!raw) {
      return;
    }

    try {
      const stored = JSON.parse(raw) as StoredAuth;
      this.cookies = stored.cookies ?? {};
      this.refreshToken = stored.refreshToken;
    } catch (error) {
      this.log(`读取登录信息失败：${toMessage(error)}`);
      return;
    }

    if (Object.keys(this.cookies).length === 0) {
      return;
    }

    try {
      await this.refreshUser();
      this.log(this.cachedUser ? `已登录：${this.cachedUser.name}` : '登录态已失效');
    } catch (error) {
      this.log(`校验登录态失败：${toMessage(error)}`);
    }
  }

  async generateQr(): Promise<LoginQr> {
    const client = new BiliClient({});
    const data = await client.get<QrGenerateData>(
      'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header',
    );

    const image = await QRCode.toDataURL(data.url, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 260,
      color: { dark: '#111111', light: '#ffffff' },
    });

    const expiresAt = Date.now() + QR_TTL_MS;
    this.pendingQr.set(data.qrcode_key, { expiresAt });

    return {
      key: data.qrcode_key,
      url: data.url,
      image,
      expiresAt,
    };
  }

  async pollQr(key: string): Promise<LoginPoll> {
    const entry = this.pendingQr.get(key);
    if (!entry) {
      return { status: 'expired', message: '二维码已失效，请刷新重试' };
    }
    if (Date.now() > entry.expiresAt) {
      this.pendingQr.delete(key);
      return { status: 'expired', message: '二维码已过期，请刷新重试' };
    }

    const response = await fetch(
      `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(
        key,
      )}&source=main-fe-header`,
      {
        headers: {
          'User-Agent': BILI_UA,
          Referer: REFERER,
          Accept: 'application/json, text/plain, */*',
          Cookie: serializeCookieJar(this.cookies),
        },
        signal: AbortSignal.timeout(20_000),
      },
    );

    if (!response.ok) {
      return { status: 'error', message: `登录接口请求失败（HTTP ${response.status}）` };
    }

    const payload = (await response.json()) as {
      code: number;
      message?: string;
      data?: QrPollData;
    };
    const data = payload.data;
    if (!data) {
      return { status: 'error', message: payload.message || '登录接口返回空数据' };
    }

    switch (data.code) {
      case 0: {
        this.cookies = mergeCookies(this.cookies, parseSetCookies(readSetCookies(response.headers)));
        this.refreshToken = data.refresh_token || this.refreshToken;
        await this.persist();
        await this.refreshUser();
        this.revision += 1;
        this.pendingQr.delete(key);
        return { status: 'success', user: this.cachedUser ?? undefined };
      }
      case 86101:
        return { status: 'waiting', message: '等待扫码' };
      case 86090:
        return { status: 'scanned', message: '已扫码，请在手机上确认' };
      case 86038:
        this.pendingQr.delete(key);
        return { status: 'expired', message: '二维码已过期，请刷新重试' };
      default:
        return { status: 'error', message: data.message || `登录失败（code ${data.code}）` };
    }
  }

  async logout(): Promise<void> {
    this.cookies = {};
    this.refreshToken = undefined;
    this.cachedUser = null;
    this.pendingQr.clear();
    this.revision += 1;
    await this.store.delete(AUTH_SECRET_KEY);
  }

  private async refreshUser(): Promise<void> {
    const nav = await this.client().nav();
    if (nav.isLogin && typeof nav.mid === 'number') {
      this.cachedUser = {
        mid: nav.mid,
        name: nav.uname || 'B站用户',
        face: nav.face || '',
        vip: nav.vipStatus === 1 || nav.vip?.status === 1,
      };
    } else {
      this.cachedUser = null;
    }
  }

  private async persist(): Promise<void> {
    const stored: StoredAuth = { cookies: this.cookies, refreshToken: this.refreshToken };
    await this.store.store(AUTH_SECRET_KEY, JSON.stringify(stored));
  }
}

function readSetCookies(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetter.getSetCookie === 'function') {
    return withGetter.getSetCookie();
  }

  const combined = headers.get('set-cookie');
  if (!combined) {
    return [];
  }

  return combined.split(/,(?=\s*[^;,]+=)/g);
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
