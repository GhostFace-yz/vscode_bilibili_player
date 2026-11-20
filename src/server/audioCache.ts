import * as fs from 'node:fs';
import * as path from 'node:path';

export interface AudioCacheStats {
  files: number;
  bytes: number;
}

const CACHE_EXTENSIONS = ['.mp3', '.wav'];

/**
 * 清理音频缓存：按总大小限额删除最旧的文件。
 * - 永远保留最新的一个文件（哪怕它自己就超限），避免正在播的视频被删
 * - 顺手清掉转码中断留下的 .source.m4s / .tmp 碎片
 */
export function pruneAudioCache(dir: string, maxBytes: number, keepAtLeast = 1): AudioCacheStats {
  try {
    const entries = fs.readdirSync(dir);
    const files = entries
      .filter(
        (name) =>
          CACHE_EXTENSIONS.some((extension) => name.endsWith(extension)) &&
          !name.includes('.tmp.'),
      )
      .map((name) => {
        const file = path.join(dir, name);
        const stat = fs.statSync(file);
        return { file, name, size: stat.size, time: stat.mtimeMs };
      })
      .sort((a, b) => b.time - a.time);

    // 转码中断留下的临时文件
    for (const name of entries) {
      if (name.endsWith('.source.m4s') || name.includes('.tmp.')) {
        fs.rmSync(path.join(dir, name), { force: true });
      }
    }

    let total = files.reduce((sum, entry) => sum + entry.size, 0);
    const limit = Math.max(0, maxBytes);
    for (let index = files.length - 1; index >= 0; index -= 1) {
      // index 0 是最新的文件：至少要保留它（keepAtLeast 默认 1）
      if (total <= limit || index < keepAtLeast) {
        break;
      }
      const entry = files[index];
      fs.rmSync(entry.file, { force: true });
      total -= entry.size;
      files.splice(index, 1);
    }

    return { files: files.length, bytes: total };
  } catch {
    return { files: 0, bytes: 0 };
  }
}

export function audioCacheStats(dir: string): AudioCacheStats {
  try {
    return fs
      .readdirSync(dir)
      .filter(
        (name) =>
          CACHE_EXTENSIONS.some((extension) => name.endsWith(extension)) &&
          !name.includes('.tmp.'),
      )
      .reduce(
        (stats, name) => {
          const stat = fs.statSync(path.join(dir, name));
          return { files: stats.files + 1, bytes: stats.bytes + stat.size };
        },
        { files: 0, bytes: 0 },
      );
  } catch {
    return { files: 0, bytes: 0 };
  }
}
