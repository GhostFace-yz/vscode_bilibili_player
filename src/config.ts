import * as vscode from 'vscode';

export type FitMode = 'cover' | 'contain' | 'fill';

export interface BilibiliPlayerSettings {
  defaultVideo: string;
  opacity: number;
  blur: number;
  fit: FitMode;
  muted: boolean;
  autoplay: boolean;
  danmaku: boolean;
  quality: number;
  useIframePlayer: boolean;
}

export function getSettings(): BilibiliPlayerSettings {
  const config = vscode.workspace.getConfiguration('bilibiliPlayer');

  return {
    defaultVideo: config.get<string>('defaultVideo', '').trim(),
    opacity: clamp(config.get<number>('opacity', 0.35), 0.05, 1),
    blur: clamp(config.get<number>('blur', 0), 0, 40),
    fit: config.get<FitMode>('fit', 'cover'),
    muted: config.get<boolean>('muted', true),
    autoplay: config.get<boolean>('autoplay', true),
    danmaku: config.get<boolean>('danmaku', false),
    quality: config.get<number>('quality', 80),
    useIframePlayer: config.get<boolean>('useIframePlayer', false),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}
