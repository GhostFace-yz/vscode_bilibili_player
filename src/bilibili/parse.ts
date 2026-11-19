import type { VideoRef } from '../shared/types';

export type { VideoRef };

export interface EmbedOptions {
  autoplay?: boolean;
  danmaku?: boolean;
  quality?: number;
  page?: number;
  startSeconds?: number;
}

const BV_PATTERN = /\bBV[0-9A-Za-z]{10}\b/;
const AV_PATTERN = /\bav(\d+)\b/i;
const BILIBILI_HOST_PATTERN = /(^|\.)bilibili\.com$/i;

/**
 * 解析用户输入：BV 号、av 号或 B 站视频链接。
 * 无法识别时返回 undefined，便于调用方做输入校验。
 */
export function parseVideoInput(raw: string): VideoRef | undefined {
  const input = raw.trim();
  if (!input) {
    return undefined;
  }

  let page: number | undefined;
  let startSeconds: number | undefined;

  if (/^https?:\/\//i.test(input)) {
    try {
      const url = new URL(input);
      if (!BILIBILI_HOST_PATTERN.test(url.hostname)) {
        return undefined;
      }

      const pageParam = Number(url.searchParams.get('p'));
      if (Number.isInteger(pageParam) && pageParam > 0) {
        page = pageParam;
      }

      const startParam = url.searchParams.get('t');
      if (startParam) {
        startSeconds = parseStartTime(startParam);
      }
    } catch {
      return undefined;
    }
  }

  const bvMatch = BV_PATTERN.exec(input);
  if (bvMatch) {
    return { bvid: bvMatch[0], page, startSeconds };
  }

  const avMatch = AV_PATTERN.exec(input);
  if (avMatch) {
    return { aid: avMatch[1], page, startSeconds };
  }

  return undefined;
}

/** 生成官方 iframe 播放器地址（安全模式使用）。 */
export function buildEmbedUrl(ref: VideoRef, options: EmbedOptions = {}): string {
  const params = new URLSearchParams();

  if (ref.bvid) {
    params.set('bvid', ref.bvid);
  } else if (ref.aid) {
    params.set('aid', ref.aid);
  }

  const page = options.page ?? ref.page;
  if (page && page > 1) {
    params.set('p', String(page));
  }

  const start = options.startSeconds ?? ref.startSeconds;
  if (start && start > 0) {
    params.set('t', String(Math.floor(start)));
  }

  if (options.autoplay) {
    params.set('autoplay', '1');
  }
  params.set('danmaku', options.danmaku ? '1' : '0');
  params.set('high_quality', '1');
  params.set('as_wide', '1');

  return `https://player.bilibili.com/player.html?${params.toString()}`;
}

export function describeVideo(ref: VideoRef): string {
  const id = ref.bvid ?? (ref.aid ? `av${ref.aid}` : '未知视频');
  const page = ref.page && ref.page > 1 ? ` · P${ref.page}` : '';
  return `${id}${page}`;
}

/** 支持 "90"、"90s"、"1m30s"、"1h2m3s" 形式的起播时间。 */
function parseStartTime(value: string): number | undefined {
  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(value);
  if (!match || (!match[1] && !match[2] && !match[3])) {
    return undefined;
  }

  const [, hours = '0', minutes = '0', seconds = '0'] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}
