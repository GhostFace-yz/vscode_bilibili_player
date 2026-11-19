import type { EpisodeInfo, PlayInfo, VideoRef } from '../shared/types';
import type { BiliClient } from './client';

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

  const playurl = await client.playurl(view.bvid, cid, qn);
  const segment = playurl.durl?.[0];
  if (!segment?.url) {
    throw new Error('B 站没有返回可直连的视频流（可能需要登录或该视频受版权限制）');
  }

  if (/flv/i.test(playurl.format ?? '')) {
    throw new Error('该视频只返回 FLV 流，浏览器无法直接播放；请尝试切换清晰度');
  }

  const qualities = (playurl.accept_quality ?? []).map((quality, index) => ({
    qn: quality,
    desc: playurl.accept_description?.[index] ?? `qn ${quality}`,
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
    duration: Math.round((playurl.timelength || view.duration * 1000) / 1000),
    quality: playurl.quality,
    qualities,
    url: segment.url,
    backupUrls: segment.backup_url ?? [],
    episodes,
    episodeIndex,
  };
}
