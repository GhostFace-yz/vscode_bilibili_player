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

/** 探测时读多少字节：能证明这条线路真的在出数据（mcdn 节点会收请求但不发数据） */
const PROBE_BYTES = 16 * 1024;

/**
 * 确认 CDN 真的能出数据：403 / 超时 / 返回 HTML / 只回响应头不发 body 都算失败。
 * 之前只取 1 字节，有些节点回了响应头就挂住，探不出来，音轨就卡在 loading。
 */
export async function probeMediaUrl(url: string): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) {
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(url, {
      headers: {
        Referer: 'https://www.bilibili.com/',
        'User-Agent': BILI_UA,
        Range: `bytes=0-${PROBE_BYTES - 1}`,
      },
      signal: controller.signal,
    });
    const type = response.headers.get('content-type') ?? '';
    if (
      (response.status !== 200 && response.status !== 206) ||
      /text\/html|application\/json|text\/plain/i.test(type)
    ) {
      await response.body?.cancel().catch(() => undefined);
      return false;
    }
    const reader = response.body?.getReader();
    if (reader) {
      let received = 0;
      while (received < 4096) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        received += chunk.value?.byteLength ?? 0;
      }
      await reader.cancel().catch(() => undefined);
      // 一个字节都没读到：线路挂住了
      return received > 0;
    }
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
