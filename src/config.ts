import * as vscode from 'vscode';
import type { FitMode, SkinSettings } from './shared/types';

export interface BilibiliPlayerSettings extends SkinSettings {
  defaultVideo: string;
  useIframePlayer: boolean;
}

const FIT_MODES: FitMode[] = ['cover', 'contain', 'fill'];
const QUALITY_OPTIONS = [16, 32, 64, 74, 80, 112, 116, 120];

export function getSettings(): BilibiliPlayerSettings {
  const config = vscode.workspace.getConfiguration('bilibiliPlayer');

  return {
    defaultVideo: config.get<string>('defaultVideo', '').trim(),
    opacity: clamp(config.get<number>('opacity', 0.5), 0.05, 1),
    blur: clamp(config.get<number>('blur', 2), 0, 40),
    dim: clamp(config.get<number>('dim', 0.25), 0, 1),
    fit: normalizeFit(config.get<string>('fit', 'cover')),
    muted: config.get<boolean>('muted', true),
    autoplay: config.get<boolean>('autoplay', true),
    quality: normalizeQuality(config.get<number>('quality', 80)),
    useIframePlayer: config.get<boolean>('useIframePlayer', false),
  };
}

export function getSkinSettings(): SkinSettings {
  const { opacity, blur, dim, fit, muted, autoplay, quality } = getSettings();
  return { opacity, blur, dim, fit, muted, autoplay, quality };
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

  await Promise.all(updates);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function normalizeFit(value: string): FitMode {
  return FIT_MODES.includes(value as FitMode) ? (value as FitMode) : 'cover';
}

function normalizeQuality(value: number): number {
  return QUALITY_OPTIONS.includes(value) ? value : 80;
}
