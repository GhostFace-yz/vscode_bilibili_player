import type { EpisodeInfo, PlayInfo, VideoRef } from '../shared/types';
import type { BiliClient, DashStream, PlayurlDashData } from './client';

/**
 * 拉取视频信息与可直连的播放地址。
 * 使用 fnval=1 + platform=html5，B 站会返回 mp4（durl），可直接交给 <video>。
 */
export async function getPlayInfo(client: BiliClient, ref: VideoRef, qn: number): Promise<PlayInfo> {
  if (!ref.bvid && !ref.aid) {
    throw new Error('缺少视频编号（BV 号或 av 号）');
  }

  const view = await client.view(ref);
  const pageNumber = ref.page && ref.page > 0 ? ref.page : 1;
  const pageData = view.pages?.find((page) => page.page === pageNumber) ?? view.pages?.[0];
  const cid = pageData?.cid ?? view.cid;

  let durl: Awaited<ReturnType<BiliClient['playurl']>> | undefined;
  let durlError: unknown;
  try {
    durl = await client.playurl(view.bvid, cid, qn);
  } catch (error) {
    durlError = error;
  }

  const segment = durl?.durl?.[0];
  const durlPlayable = segment?.url && !/flv/i.test(durl?.format ?? '') ? segment : undefined;

  let dash: PlayurlDashData | undefined;
  if (qn > 64) {
    try {
      dash = await client.dashPlayurl(view.bvid, cid, qn);
    } catch {
      // 没有 DASH 时继续走 durl
    }
  }

  const dashVideo = dash?.dash ? pickDashVideo(dash.dash.video, qn) : undefined;
  const dashAudio = dash?.dash ? pickDashAudio(dash.dash.audio) : undefined;
  const useDash = Boolean(dashVideo && (!durlPlayable || dashVideo.id > (durl?.quality ?? 0)));

  if (!useDash && !durlPlayable) {
    if (durlError instanceof Error) {
      throw durlError;
    }
    throw new Error('B 站没有返回可播放的视频流（可能需要登录或该视频受版权限制）');
  }

  const qualitySource = durl?.accept_quality?.length ? durl : dash;
  const qualities = (qualitySource?.accept_quality ?? []).map((quality, index) => ({
    qn: quality,
    desc: qualitySource?.accept_description?.[index] ?? `qn ${quality}`,
  }));

  const seasonEpisodes = (view.ugc_season?.sections ?? []).flatMap((section) => section.episodes ?? []);
  let episodes: EpisodeInfo[];

  if (seasonEpisodes.length > 1) {
    episodes = seasonEpisodes.map((episode) => ({
      bvid: episode.bvid,
      cid: episode.cid,
      page: episode.page?.page ?? 1,
      title: episode.title || episode.page?.part || episode.bvid,
    }));
  } else if (view.pages && view.pages.length > 1) {
    episodes = view.pages.map((page) => ({
      bvid: view.bvid,
      cid: page.cid,
      page: page.page,
      title: page.part || `P${page.page}`,
    }));
  } else {
    episodes = [
      {
        bvid: view.bvid,
        cid,
        page: pageData?.page ?? pageNumber,
        title: pageData?.part || view.title,
      },
    ];
  }

  let episodeIndex = episodes.findIndex((episode) => episode.cid === cid);
  if (episodeIndex < 0) {
    episodeIndex = episodes.findIndex((episode) => episode.bvid === view.bvid && episode.page === pageNumber);
  }
  if (episodeIndex < 0) {
    episodeIndex = 0;
  }

  return {
    bvid: view.bvid,
    cid,
    page: pageData?.page ?? pageNumber,
    title: view.title,
    owner: view.owner?.name ?? '',
    cover: view.pic ?? '',
    duration: Math.round((durl?.timelength || dash?.timelength || view.duration * 1000) / 1000),
    quality: useDash && dashVideo ? dashVideo.id : (durl?.quality ?? 0),
    qualities,
    mode: useDash ? 'dash' : 'native',
    url: useDash && dashVideo ? pickDashUrl(dashVideo) : segment!.url,
    backupUrls: useDash && dashVideo ? pickDashBackups(dashVideo) : (segment?.backup_url ?? []),
    audioUrl: useDash && dashAudio ? pickDashUrl(dashAudio) : undefined,
    audioBackupUrls: useDash && dashAudio ? pickDashBackups(dashAudio) : undefined,
    episodes,
    episodeIndex,
  };
}


function pickDashVideo(videos: DashStream[], qn: number): DashStream | undefined {
  if (!videos.length) {
    return undefined;
  }

  const byCodec = (a: DashStream, b: DashStream) => codecScore(b.codecid) - codecScore(a.codecid);
  const exact = videos.filter((video) => video.id === qn).sort(byCodec)[0];
  if (exact) {
    return exact;
  }

  const lower = [...new Set(videos.filter((video) => video.id < qn).map((video) => video.id))]
    .sort((a, b) => b - a)
    .map((id) => videos.filter((video) => video.id === id).sort(byCodec)[0])
    .find(Boolean);
  if (lower) {
    return lower;
  }

  return [...videos].sort((a, b) => b.id - a.id || byCodec(a, b))[0];
}

function pickDashAudio(audio: DashStream[]): DashStream | undefined {
  if (!audio.length) {
    return undefined;
  }
  const aac = audio.filter(
    (stream) => stream.codecid === 0 && /^mp4a\.40\.2/.test(stream.codecs),
  );
  const pool = aac.length > 0 ? aac : audio.filter((stream) => stream.codecid === 0);
  return pool.sort((a, b) => b.bandwidth - a.bandwidth)[0] ?? audio[0];
}

function codecScore(codecid: number): number {
  if (codecid === 7) {
    return 3; // H.264
  }
  if (codecid === 13) {
    return 2; // AV1
  }
  if (codecid === 12) {
    return 1; // HEVC
  }
  return 0;
}

function pickDashUrl(stream: DashStream): string {
  return stream.baseUrl || stream.base_url || '';
}

function pickDashBackups(stream: DashStream): string[] {
  return stream.backupUrl ?? stream.backup_url ?? [];
}
