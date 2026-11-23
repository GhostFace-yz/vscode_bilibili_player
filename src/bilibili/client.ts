import { serializeCookieJar, type CookieJar } from './cookies';
import type { VideoRef } from '../shared/types';

export const BILI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const REFERER = 'https://www.bilibili.com/';
const TIMEOUT_MS = 20_000;

export interface ViewPage {
  cid: number;
  page: number;
  part: string;
  duration: number;
}

export interface SeasonEpisode {
  aid?: number;
  bvid: string;
  cid: number;
  title: string;
  page?: { cid?: number; page?: number; part?: string };
}

export interface ViewData {
  bvid: string;
  aid: number;
  cid: number;
  title: string;
  pic: string;
  duration: number;
  owner: { name: string };
  pages?: ViewPage[];
  ugc_season?: {
    title?: string;
    sections?: { episodes?: SeasonEpisode[] }[];
  };
}

export interface DurlSegment {
  url: string;
  backup_url?: string[];
  size: number;
  length?: number;
}

export interface PlayurlData {
  quality: number;
  format: string;
  timelength: number;
  accept_quality?: number[];
  accept_description?: string[];
  durl?: DurlSegment[];
}

export interface DashStream {
  id: number;
  baseUrl: string;
  base_url?: string;
  backupUrl?: string[];
  backup_url?: string[];
  bandwidth: number;
  mimeType: string;
  codecs: string;
  codecid: number;
  width?: number;
  height?: number;
  SegmentBase?: { Initialization?: string; indexRange?: string };
  WorkingIsBoring: true;
}

export interface DashData {
  duration: number;
  video: DashStream[];
  audio: DashStream[];
}

export interface PlayurlDashData {
  dash?: DashData;
  timelength?: number;
  accept_quality?: number[];
  accept_description?: string[];
}

export interface NavData {
  isLogin: boolean;
  mid?: number;
  uname?: string;
  face?: string;
  vipStatus?: number;
  vip?: { status?: number };
}

interface ApiEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

export class BiliError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'BiliError';
  }
}

export class BiliClient {
  constructor(private readonly cookies: CookieJar = {}) {}

  async view(ref: VideoRef): Promise<ViewData> {
    const query = ref.bvid ? `bvid=${encodeURIComponent(ref.bvid)}` : `aid=${encodeURIComponent(ref.aid ?? '')}`;
    return this.get<ViewData>(`https://api.bilibili.com/x/web-interface/view?${query}`);
  }

  async playurl(bvid: string, cid: number, qn: number): Promise<PlayurlData> {
    const params = new URLSearchParams({
      bvid,
      cid: String(cid),
      qn: String(qn),
      fnval: '1',
      fourk: '1',
      platform: 'html5',
      high_quality: '1',
    });
    return this.get<PlayurlData>(`https://api.bilibili.com/x/player/playurl?${params.toString()}`);
  }

  async dashPlayurl(bvid: string, cid: number, qn: number): Promise<PlayurlDashData> {
    const params = new URLSearchParams({
      bvid,
      cid: String(cid),
      qn: String(qn),
      fnval: '16',
      fnver: '0',
      fourk: '1',
      platform: 'pc',
    });
    return this.get<PlayurlDashData>(`https://api.bilibili.com/x/player/playurl?${params.toString()}`);
  }

  async nav(): Promise<NavData> {
    return this.get<NavData>('https://api.bilibili.com/x/web-interface/nav');
  }

  /** 直接返回 JSON 的业务字段（已校验 code === 0）。 */
  async get<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      headers: this.headers(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new BiliError(response.status, `B 站接口请求失败（HTTP ${response.status}）`);
    }

    const payload = (await response.json()) as ApiEnvelope<T>;
    if (payload.code !== 0) {
      throw new BiliError(payload.code, payload.message || `B 站接口错误（code ${payload.code}）`);
    }
    if (payload.data === null || payload.data === undefined) {
      throw new BiliError(-1, 'B 站接口返回空数据');
    }

    return payload.data;
  }

  /** 与 get 相同，但返回完整响应（用于需要读取 Set-Cookie 的登录轮询）。 */
  async raw(url: string): Promise<Response> {
    return fetch(url, {
      headers: this.headers(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': BILI_UA,
      Referer: REFERER,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    };

    const cookie = serializeCookieJar(this.cookies);
    if (cookie) {
      headers.Cookie = cookie;
    }

    return headers;
  }
}
