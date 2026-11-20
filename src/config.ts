import * as vscode from 'vscode';
import type { FitMode, MiniRect, SkinSettings } from './shared/types';
import { DEFAULT_SKIN_SETTINGS } from './shared/types';

export interface BilibiliPlayerSettings extends SkinSettings {
  defaultVideo: string;
  useIframePlayer: boolean;
  danmakuAutoScroll: boolean;
  /** 音频缓存上限（MB） */
  audioCacheMaxMb: number;
}

const FIT_MODES: FitMode[] = ['full', 'mini'];
const QUALITY_OPTIONS = [16, 32, 64, 74, 80, 112, 116, 120];

export function getSettings(): BilibiliPlayerSettings {
  const config = vscode.workspace.getConfiguration('bilibiliPlayer');

  return {
    defaultVideo: config.get<string>('defaultVideo', '').trim(),
    opacity: clamp(config.get<number>('opacity', 0.32), 0.05, 1),
    blur: clamp(config.get<number>('blur', 0), 0, 40),
    dim: clamp(config.get<number>('dim', 0), 0, 1),
    fit: normalizeFit(config.get<string>('fit', 'full')),
    muted: config.get<boolean>('muted', false),
    autoplay: config.get<boolean>('autoplay', false),
    quality: normalizeQuality(config.get<number>('quality', 80)),
    hiddenMode: config.get<boolean>('hiddenMode', false),
    cropBars: config.get<boolean>('cropBars', true),
    miniRect: normalizeMiniRect(config.get<unknown>('miniRect')),
    danmaku: config.get<boolean>('danmaku', false),
    useIframePlayer: config.get<boolean>('useIframePlayer', false),
    danmakuAutoScroll: config.get<boolean>('danmakuAutoScroll', true),
    audioCacheMaxMb: clamp(config.get<number>('audioCacheMaxMb', 120), 0, 4096),
  };
}

export function getSkinSettings(): SkinSettings {
  const { opacity, blur, dim, fit, muted, autoplay, quality, hiddenMode, cropBars, miniRect, danmaku } =
    getSettings();
  return { opacity, blur, dim, fit, muted, autoplay, quality, hiddenMode, cropBars, miniRect, danmaku };
}

/** 0.5.0 起 fit 只剩 full / mini，把老版本的 cover/contain/fill 写回 full，避免设置界面显示无效值。 */
export async function migrateLegacyFitSetting(): Promise<void> {
  const config = vscode.workspace.getConfiguration('bilibiliPlayer');
  const current = config.get<string>('fit');
  if (current && !FIT_MODES.includes(current as FitMode)) {
    await config.update('fit', 'full', vscode.ConfigurationTarget.Global);
  }
}

export async function updateSkinSettings(patch: Partial<SkinSettings>): Promise<void> {
  const config = vscode.workspace.getConfiguration('bilibiliPlayer');
  const updates: Thenable<void>[] = [];

  if (typeof patch.opacity === 'number') {
    updates.push(config.update('opacity', clamp(patch.opacity, 0.05, 1), vscode.ConfigurationTarget.Global));
  }
  if (typeof patch.blur === 'number') {
    updates.push(config.update('blur', clamp(patch.blur, 0, 40), vscode.ConfigurationTarget.Global));
  }
  if (typeof patch.dim === 'number') {
    updates.push(config.update('dim', clamp(patch.dim, 0, 1), vscode.ConfigurationTarget.Global));
  }
  if (patch.fit && FIT_MODES.includes(patch.fit)) {
    updates.push(config.update('fit', patch.fit, vscode.ConfigurationTarget.Global));
  }
  if (typeof patch.muted === 'boolean') {
    updates.push(config.update('muted', patch.muted, vscode.ConfigurationTarget.Global));
  }
  if (typeof patch.autoplay === 'boolean') {
    updates.push(config.update('autoplay', patch.autoplay, vscode.ConfigurationTarget.Global));
  }
  if (typeof patch.quality === 'number' && QUALITY_OPTIONS.includes(patch.quality)) {
    updates.push(config.update('quality', patch.quality, vscode.ConfigurationTarget.Global));
  }
  if (typeof patch.hiddenMode === 'boolean') {
    updates.push(config.update('hiddenMode', patch.hiddenMode, vscode.ConfigurationTarget.Global));
  }
  if (typeof patch.cropBars === 'boolean') {
    updates.push(config.update('cropBars', patch.cropBars, vscode.ConfigurationTarget.Global));
  }
  if (typeof patch.danmaku === 'boolean') {
    updates.push(config.update('danmaku', patch.danmaku, vscode.ConfigurationTarget.Global));
  }
  if (patch.miniRect) {
    updates.push(
      config.update('miniRect', normalizeMiniRect(patch.miniRect), vscode.ConfigurationTarget.Global),
    );
  }

  await Promise.all(updates);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function normalizeMiniRect(value: unknown): MiniRect {
  const raw = (value ?? {}) as Partial<MiniRect>;
  const read = (input: unknown, fallback: number) =>
    typeof input === 'number' && Number.isFinite(input) ? input : fallback;
  return {
    x: clamp(read(raw.x, DEFAULT_SKIN_SETTINGS.miniRect.x), 0, 1),
    y: clamp(read(raw.y, DEFAULT_SKIN_SETTINGS.miniRect.y), 0, 1),
    w: clamp(read(raw.w, DEFAULT_SKIN_SETTINGS.miniRect.w), 0.05, 1),
  };
}

function normalizeFit(value: string): FitMode {
  if (FIT_MODES.includes(value as FitMode)) {
    return value as FitMode;
  }
  // cover / contain / fill 都是老版本的铺满方式，现在统一走“完整”
  return 'full';
}

function normalizeQuality(value: number): number {
  return QUALITY_OPTIONS.includes(value) ? value : 80;
}
