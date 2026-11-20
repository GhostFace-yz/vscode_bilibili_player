import type { BiliClient } from '../bilibili/client';
import type { LiveDanmakuItem } from '../shared/types';

/**
 * B 站直播：
 * - room/v1/Room/get_info        → 标题、主播、开播状态
 * - xlive/.../getRoomPlayInfo    → 直播流地址（http_hls）
 *
 * 直播流是 HLS（TS/fMP4）。VS Code 的 libffmpeg 没有 AAC 解码器，
 * 所以真正的播放走扩展宿主：ffmpeg 把 HLS 转成 fMP4（H.264 直接 copy + 音频转 MP3），
 * 再由 <video> 当成无限长的渐进流播放。这样音画在同一条流里，天然同步。
 */
export interface LivePlayInfo {
  roomId: number;
  title: string;
  owner: string;
  cover: string;
  liveStatus: number;
  online: number;
  /** 上游 HLS 地址（m3u8），过期时间由 B 站控制 */
  streamUrl?: string;
  /** 上游视频编码：avc 时宿主直接 copy，否则转码 */
  videoCodec?: string;
  acceptQn?: number[];
  currentQn?: number;
}

interface RoomInfoResponse {
  room_id: number;
  short_id: number;
  uid: number;
  title: string;
  user_cover?: string;
  cover?: string;
  live_status: number;
  online: number;
}

interface LiveStreamCodec {
  codec_name?: string;
  current_qn?: number;
  accept_qn?: number[];
  base_url?: string;
  url_info?: { host?: string; extra?: string }[];
}

interface LiveStreamFormat {
  format_name?: string;
  codec?: LiveStreamCodec[];
}

interface LivePlayInfoResponse {
  live_status?: number;
  playurl_info?: {
    playurl?: {
      stream?: { protocol_name?: string; format?: LiveStreamFormat[] }[];
    };
  };
}

const ROOM_INFO_URL = 'https://api.live.bilibili.com/room/v1/Room/get_info';
const PLAY_INFO_URL = 'https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo';
const DANMAKU_HISTORY_URL = 'https://api.live.bilibili.com/xlive/web-room/v1/dM/gethistory';

/** 从直播间链接/房间号里取出数字房间号 */
export function parseLiveRoomId(input: string): number | null {
  const text = input.trim();
  if (!text) {
    return null;
  }
  const urlMatch = /live\.bilibili\.com\/(?:h5\/|blanc\/)?(\d{1,12})/i.exec(text);
  if (urlMatch) {
    return Number(urlMatch[1]);
  }
  if (/^\d{1,12}$/.test(text)) {
    return Number(text);
  }
  return null;
}

export async function fetchLiveRoom(
  client: BiliClient,
  input: string,
  qn = 10000,
): Promise<LivePlayInfo> {
  const roomId = parseLiveRoomId(input);
  if (!roomId) {
    throw new Error('请输入直播间链接或房间号，例如 https://live.bilibili.com/6');
  }

  const room = await client.get<RoomInfoResponse>(`${ROOM_INFO_URL}?room_id=${roomId}`);
  const info: LivePlayInfo = {
    roomId: room.room_id || roomId,
    title: room.title || `直播间 ${roomId}`,
    owner: '',
    cover: room.user_cover || room.cover || '',
    liveStatus: room.live_status,
    online: room.online,
  };

  if (room.live_status !== 1) {
    return info;
  }

  const play = await client.get<LivePlayInfoResponse>(
    `${PLAY_INFO_URL}?room_id=${info.roomId}&protocol=0,1&format=0,1,2&codec=0,1&qn=${qn}&platform=web&ptype=8&dolby=5&panorama=1`,
  );

  const picked = pickLiveStream(play);
  if (!picked) {
    throw new Error('没有拿到直播流地址（可能需要登录或该直播间限制了网页播放）');
  }

  info.liveStatus = play.live_status ?? info.liveStatus;
  info.streamUrl = picked.url;
  info.videoCodec = picked.codec;
  info.acceptQn = picked.acceptQn;
  info.currentQn = picked.currentQn;
  info.owner = await fetchOwnerName(client, room.uid).catch(() => '');
  return info;
}

function pickLiveStream(
  play: LivePlayInfoResponse,
): { url: string; codec: string; acceptQn?: number[]; currentQn?: number } | null {
  const streams = play.playurl_info?.playurl?.stream ?? [];
  // 优先 HLS：ffmpeg 能稳定读，且可以转成渐进 fMP4
  const hls = streams.find((stream) => stream.protocol_name === 'http_hls') ?? streams[0];
  if (!hls) {
    return null;
  }

  // fMP4 优先（码率/延迟都好），其次 TS
  const formats = [...(hls.format ?? [])].sort(
    (a, b) => formatScore(b.format_name) - formatScore(a.format_name),
  );

  for (const format of formats) {
    for (const codec of format.codec ?? []) {
      const urlInfo = codec.url_info?.[0];
      if (!codec.base_url || !urlInfo?.host) {
        continue;
      }
      return {
        url: `${urlInfo.host}${codec.base_url}${urlInfo.extra ?? ''}`,
        codec: codec.codec_name ?? 'avc',
        acceptQn: codec.accept_qn,
        currentQn: codec.current_qn,
      };
    }
  }
  return null;
}

function formatScore(name?: string): number {
  if (name === 'fmp4') {
    return 2;
  }
  if (name === 'ts') {
    return 1;
  }
  return 0;
}

async function fetchOwnerName(client: BiliClient, uid: number): Promise<string> {
  if (!uid) {
    return '';
  }
  const card = await client.get<{ info?: { uname?: string } }>(
    `https://api.live.bilibili.com/live_user/v1/Master/info?uid=${uid}`,
  );
  return card.info?.uname ?? '';
}

interface HistoryItem {
  id_str?: string;
  text?: string;
  nickname?: string;
}

export async function fetchLiveDanmaku(
  client: BiliClient,
  roomId: number,
): Promise<LiveDanmakuItem[]> {
  const data = await client.get<{ room?: HistoryItem[] }>(
    `${DANMAKU_HISTORY_URL}?roomid=${roomId}&room_type=0`,
  );
  return (data.room ?? [])
    .filter((item) => item.text)
    .map((item, index) => ({
      id: item.id_str ?? `${item.nickname ?? ''}-${item.text ?? ''}-${index}`,
      text: item.text ?? '',
      nickname: item.nickname ?? '',
    }));
}
