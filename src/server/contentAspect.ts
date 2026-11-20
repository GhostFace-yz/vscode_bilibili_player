import { spawn } from 'node:child_process';
import { findFfmpegBinary } from './audioTranscode';

/**
 * B 站不少片源把电影画幅压进了 16:9 的编码帧里（比如 1920x960 的画面 + 上下各 60px 黑边），
 * 黑边是像素而不是 CSS 留白，靠 object-fit 处理不掉。
 *
 * 这里用 ffmpeg 的 cropdetect 在视频里抽几段画面，取出现次数最多的裁剪框当作真实画面比例，
 * 交给 HUD 决定 <video> 的尺寸（按内容比例排布，黑边被 cover 裁到可视区外）。
 *
 * 注意：同一个视频可能混着“宽银幕过场”和“全画幅游戏画面”，所以要多点采样再投票，
 * 只有足够多的采样点给出同一个裁剪框时才认为检测结果可信。
 */
export interface ContentAspect {
  /** 画面（去掉黑边后）的像素宽高 */
  width: number;
  height: number;
  /** width / height */
  aspect: number;
  /** 编码帧是否真的被裁过（false = 本来就没有黑边） */
  cropped: boolean;
  /** 参与投票且结果一致的采样点数，用于日志/调试 */
  votes: number;
}

const SAMPLE_FRACTIONS = [0.12, 0.3, 0.48, 0.66, 0.84];
const SAMPLE_SECONDS = 2;
const FFMPEG_TIMEOUT_MS = 20_000;
/** 单段采样里同一个裁剪框至少要出现这么多帧才算稳定 */
const MIN_FRAMES_PER_SAMPLE = 8;
/** 裁剪框小于整帧这个比例时认为是暗场误判，直接丢掉 */
const MIN_CROP_AREA_RATIO = 0.5;

export async function detectContentAspect(
  videoUrl: string,
  durationSeconds: number,
): Promise<ContentAspect | null> {
  const bin = findFfmpegBinary();
  if (!bin || !/^https?:\/\//i.test(videoUrl)) {
    return null;
  }

  const results = await Promise.all(
    SAMPLE_FRACTIONS.map((fraction) =>
      sampleAt(bin, videoUrl, pickSampleTime(durationSeconds, fraction)),
    ),
  );

  const crops = results.filter((crop): crop is Crop => Boolean(crop));
  if (crops.length === 0) {
    return null;
  }

  // 同一种裁剪框可能因为编码取整有 ±2px 差异，按 8px 分桶合并
  const buckets = new Map<string, { crop: Crop; votes: number }>();
  for (const crop of crops) {
    const key = `${Math.round(crop.width / 8)}x${Math.round(crop.height / 8)}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.votes += 1;
      continue;
    }
    buckets.set(key, { crop, votes: 1 });
  }

  const ranked = [...buckets.values()].sort((a, b) => b.votes - a.votes);
  const best = ranked[0];
  const isFullFrame = best.crop.width >= best.crop.frameWidth - 4 && best.crop.height >= best.crop.frameHeight - 4;

  if (isFullFrame) {
    return {
      width: best.crop.frameWidth,
      height: best.crop.frameHeight,
      aspect: best.crop.frameWidth / best.crop.frameHeight,
      cropped: false,
      votes: best.votes,
    };
  }

  // 只有一个采样点看到黑边时不可信（暗场/转场很容易误判）
  if (best.votes < 2) {
    return null;
  }

  return {
    width: best.crop.width,
    height: best.crop.height,
    aspect: best.crop.width / best.crop.height,
    cropped: true,
    votes: best.votes,
  };
}

export interface Crop {
  width: number;
  height: number;
  frameWidth: number;
  frameHeight: number;
}

export function parseCropSamples(stderr: string): Crop | null {
  const frame = /Video:.*?,\s*(\d{2,5})x(\d{2,5})/.exec(stderr);
  const frameWidth = frame ? Number(frame[1]) : 0;
  const frameHeight = frame ? Number(frame[2]) : 0;

  const counts = new Map<string, number>();
  for (const match of stderr.matchAll(/crop=(\d{1,5}):(\d{1,5}):(\d{1,5}):(\d{1,5})/g)) {
    const key = `${match[1]}:${match[2]}:${match[3]}:${match[4]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  if (counts.size === 0) {
    return null;
  }

  const [best, bestCount] = [...counts.entries()].reduce((a, b) => (b[1] > a[1] ? b : a));
  if (bestCount < MIN_FRAMES_PER_SAMPLE) {
    return null;
  }

  const [width, height] = best.split(':').map(Number);
  if (!width || !height) {
    return null;
  }

  const fw = frameWidth || width;
  const fh = frameHeight || height;
  if ((width * height) / (fw * fh) < MIN_CROP_AREA_RATIO) {
    return null;
  }

  return { width, height, frameWidth: fw, frameHeight: fh };
}

async function sampleAt(bin: string, videoUrl: string, startSeconds: number): Promise<Crop | null> {
  const stderr = await runFfmpeg(
    bin,
    [
      '-hide_banner',
      '-nostdin',
      '-v',
      'info',
      '-ss',
      String(startSeconds),
      '-i',
      videoUrl,
      '-t',
      String(SAMPLE_SECONDS),
      '-an',
      '-sn',
      '-dn',
      '-vf',
      'cropdetect=limit=24:round=2:reset=0',
      '-f',
      'null',
      '-',
    ],
    FFMPEG_TIMEOUT_MS,
  );

  return parseCropSamples(stderr);
}

function pickSampleTime(durationSeconds: number, fraction: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 30) {
    return Math.max(1, Math.round(durationSeconds * fraction) || 5);
  }
  // 跳过片头台标和片尾
  return Math.max(2, Math.round(durationSeconds * fraction));
}

function runFfmpeg(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(stderr);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish();
    }, timeoutMs);

    child.stderr.on('data', (chunk: Buffer) => {
      // 只保留末尾，cropdetect 每帧一行，几秒就是几百行
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-200_000);
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish();
    });
    child.on('close', () => {
      clearTimeout(timer);
      finish();
    });
  });
}
