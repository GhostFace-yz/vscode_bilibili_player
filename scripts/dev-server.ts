import { BiliAuth } from '../src/bilibili/auth';
import { getPlayInfo } from '../src/bilibili/playurl';
import { fetchDanmaku } from '../src/bilibili/danmaku';
import { fetchLiveDanmaku, fetchLiveRoom } from '../src/server/live';
import { LiveDanmakuHub } from '../src/server/liveDanmaku';
import { startApiServer } from '../src/server/apiServer';
import {
  DEFAULT_SKIN_SETTINGS,
  type SkinState,
  type StatePatch,
  type VideoRef,
} from '../src/shared/types';

class MemorySecretStore {
  private readonly data = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.data.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

async function main(): Promise<void> {
  const auth = new BiliAuth(new MemorySecretStore(), (message) => console.log('[auth]', message));
  await auth.init();

  let state: SkinState = {
    visible: true,
    openLogin: false,
    video: { bvid: process.env.BILI_BVID ?? 'BV1GJ411x7h7' },
    settings: { ...DEFAULT_SKIN_SETTINGS, quality: Number(process.env.BILI_QN ?? 80) },
    loggedIn: auth.loggedIn,
    user: auth.user,
    authRevision: auth.authRevision,
  };

  const liveHub = new LiveDanmakuHub(
    () => auth.client(),
    (message) => console.log('[live-danmaku]', message),
    (roomId) => fetchLiveDanmaku(auth.client(), roomId),
  );

  const server = await startApiServer({
    token: 'dev-token',
    version: 'dev',
    getState: async () => ({
      ...state,
      loggedIn: auth.loggedIn,
      user: auth.user,
      authRevision: auth.authRevision,
    }),
    patchState: async (patch: StatePatch) => {
      if (typeof patch.visible === 'boolean') {
        state.visible = patch.visible;
      }
      if (typeof patch.openLogin === 'boolean') {
        state.openLogin = patch.openLogin;
      }
      if (patch.video !== undefined) {
        state.video = patch.video;
      }
      if (patch.settings) {
        state.settings = { ...state.settings, ...patch.settings };
      }
      return { ...state, loggedIn: auth.loggedIn, user: auth.user, authRevision: auth.authRevision };
    },
    getPlayInfo: (ref: VideoRef, qn: number) => getPlayInfo(auth.client(), ref, qn),
    cacheDir: '/tmp/bili-dev-cache',
    getDanmaku: (cid: number) => fetchDanmaku(auth.client(), cid),
    onDanmaku: (items, live) => {
      for (const item of items) {
        console.log(live ? `[danmaku:live] ${item.text}` : `[danmaku] ${item.time.toFixed(1)} ${item.text}`);
      }
    },
    getLiveRoom: (input: string) => fetchLiveRoom(auth.client(), input),
    getLiveDanmaku: (roomId: number) => liveHub.poll(roomId),
    loginQr: () => auth.generateQr(),
    loginPoll: (key: string) => auth.pollQr(key),
    logout: () => auth.logout(),
    log: (message: string) => console.log('[server]', message),
  });

  console.log(`[dev] API listening on http://127.0.0.1:${server.port} (token: dev-token)`);
  console.log('[dev] open http://127.0.0.1:8099/test/hud-fixture.html');

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
