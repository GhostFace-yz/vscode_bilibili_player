import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * VS Code 自带的 libffmpeg 没有 AAC 解码器（只有 mp3 / flac / vorbis / pcm），
 * 所以 B 站音轨在 workbench 里会报 DEMUXER_ERROR_NO_SUPPORTED_STREAMS。
 * 这里把 AAC 转成 VS Code 能解码的 MP3（ffmpeg）或 WAV（macOS afconvert）。
 */
export interface AudioTranscoder {
  name: string;
  extension: 'mp3' | 'wav';
  contentType: string;
  convert(input: string, output: string): Promise<void>;
}

const FFMPEG_CANDIDATES = [
  process.env.BILI_FFMPEG_PATH,
  '/opt/homebrew/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  '/usr/bin/ffmpeg',
].filter((value): value is string => Boolean(value));

let cached: AudioTranscoder | null | undefined;

export function findAudioTranscoder(): AudioTranscoder | null {
  if (cached !== undefined) {
    return cached;
  }

  const ffmpeg = FFMPEG_CANDIDATES.find(isExecutable) ?? findInPath('ffmpeg');
  if (ffmpeg) {
    cached = ffmpegTranscoder(ffmpeg);
    return cached;
  }

  if (process.platform === 'darwin' && isExecutable('/usr/bin/afconvert')) {
    cached = afconvertTranscoder('/usr/bin/afconvert');
    return cached;
  }

  cached = null;
  return cached;
}

function ffmpegTranscoder(bin: string): AudioTranscoder {
  return {
    name: `ffmpeg (${bin})`,
    extension: 'mp3',
    contentType: 'audio/mpeg',
    convert: (input, output) =>
      run(bin, [
        '-y',
        '-v',
        'error',
        '-i',
        input,
        '-vn',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '192k',
        '-ar',
        '48000',
        '-ac',
        '2',
        output,
      ]),
  };
}

function afconvertTranscoder(bin: string): AudioTranscoder {
  // 没有 ffmpeg 时的 macOS 兜底：32kHz 单声道 PCM，30 分钟约 90MB。
  return {
    name: `afconvert (${bin})`,
    extension: 'wav',
    contentType: 'audio/wav',
    convert: (input, output) =>
      run(bin, ['-f', 'WAVE', '-d', 'LEI16@32000', '-c', '1', input, output]),
  };
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function findInPath(name: string): string | undefined {
  const entries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const entry of entries) {
    const candidate = path.join(entry, name);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${path.basename(bin)} 退出码 ${code}：${stderr.trim() || '无输出'}`));
    });
  });
}
