import type { DanmakuItem } from '../shared/types';
import type { BiliClient } from './client';

/**
 * B 站旧版弹幕 XML 接口：`<d p="时间,模式,字号,颜色,...,">内容</d>`。
 * 这个接口不需要登录，带 UA + Referer 就能拿到整段弹幕（最多 6000 条）。
 */
const DANMAKU_URL = 'https://api.bilibili.com/x/v1/dm/list.so';

export async function fetchDanmaku(client: BiliClient, cid: number): Promise<DanmakuItem[]> {
  const response = await client.raw(`${DANMAKU_URL}?oid=${encodeURIComponent(String(cid))}`);
  if (!response.ok) {
    throw new Error(`弹幕接口请求失败（HTTP ${response.status}）`);
  }

  // undici 会按 Content-Encoding 自动解压（B 站这里是 deflate）
  const xml = Buffer.from(await response.arrayBuffer()).toString('utf8');
  return parseDanmakuXml(xml);
}

export function parseDanmakuXml(xml: string): DanmakuItem[] {
  if (!xml.includes('<d ')) {
    return [];
  }

  const items: DanmakuItem[] = [];
  for (const match of xml.matchAll(/<d p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g)) {
    const time = Number.parseFloat(match[1].split(',')[0] ?? '');
    const text = decodeEntities(match[2]).trim();
    if (!Number.isFinite(time) || time < 0 || !text) {
      continue;
    }
    items.push({ time, text });
  }

  return items.sort((a, b) => a.time - b.time);
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
