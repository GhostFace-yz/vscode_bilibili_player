import { brotliDecompressSync, inflateSync } from 'node:zlib';
import type { BiliClient } from '../bilibili/client';
import type { LiveDanmakuItem } from '../shared/types';

/**
 * 直播弹幕：B 站的 danmaku WebSocket 协议。
 *
 * 先调 `getDanmuInfo` 拿弹幕服务器和 token，再连 `wss://<host>/sub`，
 * 认证包 op=7、心跳 op=2，收到的 op=5 帧里是 JSON（protover 2/3 分别是 zlib/brotli 压缩）。
 *
 * 该接口受风控保护（-352）：登录态下可用；失败时退回 `getLiveDanmaku` 的历史接口，
 * 并在输出面板说明，避免直播弹幕整个失效。
 */
export interface LiveDanmakuSource {
  poll(roomId: number): Promise<LiveDanmakuItem[]>;
  dispose(): void;
}

interface RoomState {
  items: LiveDanmakuItem[];
  seen: Set<string>;
  lastPoll: number;
  socket?: WebSocket;
  heartbeat?: NodeJS.Timeout;
  reconnect?: NodeJS.Timeout;
  connecting: boolean;
  useHistoryFallback: boolean;
}

const DANMU_INFO_URL = 'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo';
const IDLE_MS = 90_000;
const HEARTBEAT_MS = 30_000;

export class LiveDanmakuHub implements LiveDanmakuSource {
  private readonly rooms = new Map<number, RoomState>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly clientFactory: () => BiliClient,
    private readonly log?: (message: string, tag?: '弹幕') => void,
    private readonly historyFallback?: (roomId: number) => Promise<LiveDanmakuItem[]>,
  ) {
    this.sweeper = setInterval(() => this.sweepIdle(), 30_000);
    this.sweeper.unref?.();
  }

  async poll(roomId: number): Promise<LiveDanmakuItem[]> {
    const state = this.room(roomId);
    state.lastPoll = Date.now();
    if (!state.socket && !state.connecting) {
      void this.connect(roomId, state);
    }
    return state.items.splice(0, state.items.length);
  }

  dispose(): void {
    clearInterval(this.sweeper);
    for (const [roomId, state] of this.rooms) {
      this.close(roomId, state);
    }
    this.rooms.clear();
  }

  private room(roomId: number): RoomState {
    let state = this.rooms.get(roomId);
    if (!state) {
      state = {
        items: [],
        seen: new Set(),
        lastPoll: Date.now(),
        connecting: false,
        useHistoryFallback: false,
      };
      this.rooms.set(roomId, state);
    }
    return state;
  }

  private sweepIdle(): void {
    const now = Date.now();
    for (const [roomId, state] of this.rooms) {
      if (now - state.lastPoll > IDLE_MS) {
        this.close(roomId, state);
        this.rooms.delete(roomId);
      }
    }
  }

  private close(roomId: number, state: RoomState): void {
    if (state.heartbeat) {
      clearInterval(state.heartbeat);
      state.heartbeat = undefined;
    }
    if (state.reconnect) {
      clearTimeout(state.reconnect);
      state.reconnect = undefined;
    }
    try {
      state.socket?.close();
    } catch {
      // 已经断开
    }
    state.socket = undefined;
    void roomId;
  }

  private async connect(roomId: number, state: RoomState): Promise<void> {
    state.connecting = true;
    try {
      if (state.useHistoryFallback) {
        await this.pollHistory(roomId, state);
        return;
      }

      const client = this.clientFactory();
      const info = await client.get<{
        token?: string;
        host_list?: { host?: string; wss_port?: number }[];
      }>(`${DANMU_INFO_URL}?id=${roomId}&type=0`);
      const host = info.host_list?.[0];
      if (!host?.host) {
        throw new Error('没有返回弹幕服务器地址');
      }

      const socket = new WebSocket(`wss://${host.host}:${host.wss_port ?? 443}/sub`);
      socket.binaryType = 'arraybuffer';
      state.socket = socket;

      socket.onopen = () => {
        state.useHistoryFallback = false;
        const auth = {
          uid: 0,
          roomid: roomId,
          protover: 3,
          platform: 'web',
          type: 2,
          key: info.token ?? '',
        };
        socket.send(buildPacket(7, Buffer.from(JSON.stringify(auth), 'utf8')));
        socket.send(buildPacket(2, Buffer.alloc(0)));
        state.heartbeat = setInterval(() => {
          try {
            socket.send(buildPacket(2, Buffer.alloc(0)));
          } catch {
            // 忽略
          }
        }, HEARTBEAT_MS);
        this.log?.(`直播弹幕已连接（房间 ${roomId}）`, '弹幕');
      };

      socket.onmessage = (event: MessageEvent) => {
        const data = event.data;
        if (!(data instanceof ArrayBuffer)) {
          return;
        }
        for (const item of decodeDanmakuPackets(Buffer.from(data))) {
          if (state.seen.has(item.id)) {
            continue;
          }
          state.seen.add(item.id);
          state.items.push(item);
        }
        if (state.seen.size > 1000) {
          state.seen = new Set(state.items.slice(-200).map((item) => item.id));
        }
        if (state.items.length > 300) {
          state.items.splice(0, state.items.length - 300);
        }
      };

      const fail = (reason: string) => {
        this.log?.(`直播弹幕连接中断：${reason}`, '弹幕');
        this.close(roomId, state);
        if (Date.now() - state.lastPoll < 60_000) {
          state.reconnect = setTimeout(() => void this.connect(roomId, state), 3000);
        }
      };
      socket.onclose = () => fail('连接已关闭');
      socket.onerror = () => fail('连接错误');
    } catch (error) {
      // 风控（-352）或未登录：退回历史接口
      state.useHistoryFallback = true;
      this.log?.(
        `直播弹幕 WebSocket 不可用（${error instanceof Error ? error.message : String(error)}），改用历史弹幕接口`,
        '弹幕',
      );
      await this.pollHistory(roomId, state);
    } finally {
      state.connecting = false;
    }
  }

  private async pollHistory(roomId: number, state: RoomState): Promise<void> {
    if (!this.historyFallback) {
      return;
    }
    try {
      const items = await this.historyFallback(roomId);
      for (const item of items) {
        if (state.seen.has(item.id)) {
          continue;
        }
        state.seen.add(item.id);
        state.items.push(item);
      }
    } catch (error) {
      this.log?.(
        `直播弹幕获取失败：${error instanceof Error ? error.message : String(error)}`,
        '弹幕',
      );
    }
  }
}

function buildPacket(op: number, body: Buffer): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(16 + body.length, 0);
  header.writeUInt16BE(16, 4);
  header.writeUInt16BE(1, 6);
  header.writeUInt32BE(op, 8);
  header.writeUInt32BE(1, 12);
  return Buffer.concat([header, body]);
}

export function decodeDanmakuPackets(buffer: Buffer): LiveDanmakuItem[] {
  const items: LiveDanmakuItem[] = [];
  walk(buffer, items);
  return items;
}

function walk(buffer: Buffer, items: LiveDanmakuItem[]): void {
  let offset = 0;
  while (offset + 16 <= buffer.length) {
    const total = buffer.readUInt32BE(offset);
    const headerLen = buffer.readUInt16BE(offset + 4);
    const version = buffer.readUInt16BE(offset + 6);
    const op = buffer.readUInt32BE(offset + 8);
    if (total < headerLen || offset + total > buffer.length) {
      return;
    }
    const body = buffer.subarray(offset + headerLen, offset + total);
    offset += total;
    try {
      if (version === 2) {
        walk(inflateSync(body), items);
      } else if (version === 3) {
        walk(brotliDecompressSync(body), items);
      } else if (op === 5) {
        collect(body, items);
      }
    } catch {
      // 压缩/解析失败的单帧直接丢弃
    }
  }
}

function collect(body: Buffer, items: LiveDanmakuItem[]): void {
  let payload: { cmd?: string; info?: unknown[] };
  try {
    payload = JSON.parse(body.toString('utf8')) as { cmd?: string; info?: unknown[] };
  } catch {
    return;
  }
  if (!payload.cmd || !payload.cmd.startsWith('DANMU_MSG')) {
    return;
  }
  const info = payload.info ?? [];
  const text = typeof info[1] === 'string' ? info[1] : '';
  const user = Array.isArray(info[2]) ? info[2] : [];
  const nickname = typeof user[1] === 'string' ? user[1] : '';
  if (!text) {
    return;
  }
  const meta = Array.isArray(info[0]) ? (info[0] as unknown[]) : [];
  const id = String(meta[5] ?? meta[4] ?? `${nickname}:${text}`);
  items.push({ id, text, nickname });
}
