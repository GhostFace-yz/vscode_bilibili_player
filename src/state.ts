import * as vscode from 'vscode';
import type { BiliAuth } from './bilibili/auth';
import { parseVideoInput } from './bilibili/parse';
import { getSkinSettings, updateSkinSettings } from './config';
import type { SkinState, StatePatch, VideoRef } from './shared/types';

const VIDEO_KEY = 'bilibiliPlayer.video';
const VISIBLE_KEY = 'bilibiliPlayer.visible';
const OPEN_LOGIN_KEY = 'bilibiliPlayer.openLogin';

export class ExtensionState {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly auth: BiliAuth,
  ) {}

  /**
   * 构造给皮肤用的状态快照。
   * openLogin 是“一次性信号”：读取后立即清除，避免 HUD 反复弹出登录框。
   */
  async snapshot(consumeOpenLogin = true): Promise<SkinState> {
    const openLogin = this.context.globalState.get<boolean>(OPEN_LOGIN_KEY, false);
    if (consumeOpenLogin && openLogin) {
      await this.context.globalState.update(OPEN_LOGIN_KEY, false);
    }

    const stored = this.context.globalState.get<VideoRef | null | undefined>(VIDEO_KEY);
    const video = stored === undefined ? this.fallbackVideo() : stored;

    return {
      visible: this.context.globalState.get<boolean>(VISIBLE_KEY, false),
      openLogin,
      video,
      settings: getSkinSettings(),
      loggedIn: this.auth.loggedIn,
      user: this.auth.user,
      authRevision: this.auth.authRevision,
    };
  }

  async patch(patch: StatePatch): Promise<SkinState> {
    if (typeof patch.visible === 'boolean') {
      await this.context.globalState.update(VISIBLE_KEY, patch.visible);
    }
    if (typeof patch.openLogin === 'boolean') {
      await this.context.globalState.update(OPEN_LOGIN_KEY, patch.openLogin);
    }
    if (patch.video !== undefined) {
      await this.context.globalState.update(VIDEO_KEY, patch.video);
    }
    if (patch.settings) {
      await updateSkinSettings(patch.settings);
    }

    return this.snapshot(false);
  }

  private fallbackVideo(): VideoRef | null {
    const defaultVideo = vscode.workspace.getConfiguration('bilibiliPlayer').get<string>('defaultVideo', '').trim();
    if (!defaultVideo) {
      return null;
    }
    const ref = parseVideoInput(defaultVideo);
    return ref ? { bvid: ref.bvid, aid: ref.aid, page: ref.page } : null;
  }
}
