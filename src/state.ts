import * as vscode from 'vscode';
import type { BiliAuth } from './bilibili/auth';
import { parseVideoInput } from './bilibili/parse';
import { getSkinSettings, updateSkinSettings } from './config';
import type { SkinState, StatePatch, VideoRef } from './shared/types';

export const ENABLED_KEY = 'bilibiliPlayer.enabledIntent';
const VIDEO_KEY = 'bilibiliPlayer.video';
const OPEN_LOGIN_KEY = 'bilibiliPlayer.openLogin';
/** 旧版本把显示状态存在 globalState 里，多窗口会一起显示/一起出声，升上来后清掉 */
const LEGACY_VISIBLE_KEY = 'bilibiliPlayer.visible';

export class ExtensionState {
  /**
   * 皮肤是否显示：只在当前窗口内存里保存。
   * 放 globalState 会让「开启」把每个打开的窗口都点亮（同时出声），
   * 关闭某个窗口的播放器时另一个窗口又关不掉。
   */
  private visible = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly auth: BiliAuth,
  ) {
    if (this.context.globalState.get<boolean>(LEGACY_VISIBLE_KEY, false)) {
      void this.context.globalState.update(LEGACY_VISIBLE_KEY, undefined);
    }
  }

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
      visible: this.visible,
      enabled: this.context.globalState.get<boolean>(ENABLED_KEY, false),
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
      this.visible = patch.visible;
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
