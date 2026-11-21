import { BILI_UA } from '../bilibili/client';

/**
 * B 站 playurl 会给出多个 CDN 地址，第一个偶尔 403 / 超时 / 被换成 HTML。
 * 直接交给 <video> 就是 MEDIA_ERR_SRC_NOT_SUPPORTED（错误码 4），
 * 表现就是“开启后没有画面，点重试才正常”。这里按顺序探一下，
 * 把第一个真正能用的地址排到前面；全都探不通就保持原顺序。
 */
export async function preferReachableUrl(
  url: string,
  backups: string[] = [],
): Promise<{ url: string; backups: string[] }> {
  const candidates = [url, ...backups].filter((item) => Boolean(item));
  if (candidates.length <= 1) {
    return { url, backups };
  }
  for (let index = 0; index < candidates.length; index += 1) {
    if (!(await probeMediaUrl(candidates[index]))) {
      continue;
    }
    if (index === 0) {
      return { url, backups };
    }
    return {
      url: candidates[index],
      backups: candidates.filter((_, position) => position !== index),
    };
  }
  return { url, backups };
}

/** 只取 1 字节确认 CDN 真的能出数据（403/超时/返回 HTML 都算失败）。 */
export async function probeMediaUrl(url: string): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) {
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(url, {
      headers: {
        Referer: 'https://www.bilibili.com/',
        'User-Agent': BILI_UA,
        Range: 'bytes=0-1',
      },
      signal: controller.signal,
    });
    const type = response.headers.get('content-type') ?? '';
    const usable =
      (response.status === 200 || response.status === 206) &&
      !/text\/html|application\/json|text\/plain/i.test(type);
    await response.body?.cancel().catch(() => undefined);
    return usable;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
