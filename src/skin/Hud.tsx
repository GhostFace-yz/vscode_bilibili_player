import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import {
  ChevronLeft,
  ChevronRight,
  MessageDots,
  Minus,
  PictureInPicture,
  PlayerPause,
  PlayerPlay,
  Qrcode,
  Refresh,
  Settings,
  UserCircle,
  Volume,
  X,
} from '@ricons/tabler';
import { ChevronRight20Filled } from '@ricons/fluent';
import { LiveTvFilled, MoreHorizTwotone } from '@ricons/material';
import { Toaster, toast } from 'sonner';
import { parseVideoInput } from '../bilibili/parse';
import type {
  DanmakuItem,
  LiveRoomInfo,
  LoginQr,
  MiniRect,
  PlayInfo,
  SkinConfig,
  SkinSettings,
  SkinState,
  VideoRef,
} from '../shared/types';
import { DEFAULT_SKIN_SETTINGS } from '../shared/types';
import { SkinApi } from './api';
import { Button } from './components/ui/button';
import { Slider } from './components/ui/slider';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './components/ui/tooltip';
import { Switch } from './components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './components/ui/select';
import logoUrl from './logo.png';

gsap.registerPlugin(useGSAP);

interface HudProps {
  config: SkinConfig;
  videoHost: HTMLElement;
}

const QUALITY_CHOICES = [16, 32, 64, 74, 80, 112, 116, 120];
/** 胶囊 width 过渡时长，必须和 tailwind.css 里 .bili-pill 的 transition 一致 */
const PILL_MOTION_MS = 760;
/** 卡顿后至少缓冲到这么多秒再继续播放，避免刚恢复又立刻卡住 */
const BUFFER_AHEAD_SECONDS = 2.5;

/** 当前播放位置后面还有多少秒已缓冲的数据。 */
function bufferedAhead(video: HTMLVideoElement): number {
  const time = video.currentTime;
  for (let i = 0; i < video.buffered.length; i += 1) {
    if (video.buffered.start(i) <= time + 0.1 && time <= video.buffered.end(i)) {
      return video.buffered.end(i) - time;
    }
  }
  return 0;
}
/** 小屏视频框的最小宽度（px） */
const MINI_MIN_WIDTH = 120;

/**
 * 面板开合状态记在渲染进程里：默认收起成胶囊，不挡代码；
 * 只有用户自己展开过，下次窗口才保持展开。
 */
const PANEL_PREF_KEY = 'bili.skin.panel';
type PanelPref = 'open' | 'pill' | null;

function readPanelPref(): PanelPref {
  try {
    const value = window.localStorage.getItem(PANEL_PREF_KEY);
    return value === 'open' || value === 'pill' ? value : null;
  } catch {
    return null;
  }
}

type MiniBoxRect = { x: number; y: number; w: number; h: number };

const LIVE_QUALITY_NAMES: Record<number, string> = {
  10000: '原画',
  400: '蓝光',
  250: '超清',
  150: '高清',
  80: '流畅',
};

function liveQualityLabel(qn: number): string {
  return LIVE_QUALITY_NAMES[qn] ?? `qn ${qn}`;
}

function lowerBound(items: DanmakuItem[], time: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (items[mid].time < time) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}
const REDUCED_MOTION =
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function Hud({ config, videoHost }: HudProps) {
  const api = useMemo(() => new SkinApi(config), [config]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const hudRootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLDivElement | null>(null);
  const modalOverlayRef = useRef<HTMLDivElement | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const panelContentRef = useRef<HTMLDivElement | null>(null);
  const pillContentRef = useRef<HTMLDivElement | null>(null);
  const morphRef = useRef<gsap.core.Timeline | null>(null);
  const pendingExpandFrom = useRef<{ width: number; height: number } | null>(null);
  const pendingCollapseIn = useRef(false);

  const [state, setState] = useState<SkinState | null>(null);
  const [settings, setSettings] = useState<SkinSettings>(DEFAULT_SKIN_SETTINGS);
  const [info, setInfo] = useState<PlayInfo | null>(null);
  const [srcUrl, setSrcUrl] = useState<string | null>(null);
  const [audioSrc, setAudioSrc] = useState<string | null>(null);
  const [editorBounds, setEditorBounds] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
    right: number;
    bottom: number;
  } | null>(null);
  const [topInset, setTopInset] = useState(0);
  const [stickyHeight, setStickyHeight] = useState(0);
  const [minimapWidth, setMinimapWidth] = useState(0);
  const [miniEditing, setMiniEditing] = useState(false);
  const [miniDraft, setMiniDraft] = useState<MiniBoxRect | null>(null);
  const [miniPreviewWidth, setMiniPreviewWidth] = useState(0);
  const [miniPreviewHeight, setMiniPreviewHeight] = useState(0);
  const [miniBodyHeight, setMiniBodyHeight] = useState<number | null>(null);
  const [liveMode, setLiveMode] = useState(false);
  const [liveRoom, setLiveRoom] = useState<LiveRoomInfo | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const liveSeenIds = useRef<Set<string>>(new Set());
  const [danmakuList, setDanmakuList] = useState<DanmakuItem[] | null>(null);
  const danmakuListRef = useRef<DanmakuItem[] | null>(null);
  const danmakuCursor = useRef(0);
  const danmakuLastTime = useRef(0);
  const danmakuEmitAt = useRef(0);
  danmakuListRef.current = danmakuList;
  const miniDraftRef = useRef<MiniBoxRect | null>(null);
  miniDraftRef.current = miniDraft;
  const miniGesture = useRef<{
    mode: 'move' | 'resize';
    startX: number;
    startY: number;
    rect: MiniBoxRect;
    scale: number;
  } | null>(null);
  const miniBoxRef = useRef<HTMLDivElement | null>(null);
  const miniPreviewRef = useRef<HTMLDivElement | null>(null);
  const normalBodyRef = useRef<HTMLDivElement | null>(null);
  const [videoRatio, setVideoRatio] = useState(0);
  const [contentAspect, setContentAspect] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [audioReady, setAudioReady] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const bufferingRef = useRef(false);
  /** 首次加载后是否已经提示过“点击播放”，以及用户是否已经主动播放过 */
  const readyPromptedRef = useRef(false);
  const startedRef = useRef(false);
  /** 这一个视频源是否真的播起来过（onPlaying 之后才为 true）。 */
  const hasPlayedRef = useRef(false);
  /** 最近一次 play() 的时间：初始缓冲期间不能 pause()，否则会打断 play()。 */
  const playRequestedAt = useRef(0);
  /** 点播暂停在第一帧时，确保浏览器真的把这一帧画出来（每换一次源只做一次）。 */
  const frameNudged = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [panelPref] = useState<PanelPref>(readPanelPref);
  const [open, setOpen] = useState(panelPref === 'open');
  const [hudHovered, setHudHovered] = useState(false);
  const [pillWide, setPillWide] = useState(false);
  const [pillExpanding, setPillExpanding] = useState(false);
  const [pillCollapsing, setPillCollapsing] = useState(false);
  const pillExpandedAt = useRef(0);
  const pillExpandTimer = useRef<number | undefined>(undefined);
  const pillCollapseTimer = useRef<number | undefined>(undefined);
  const pillTitleWrapRef = useRef<HTMLSpanElement | null>(null);
  const pillTitleRef = useRef<HTMLSpanElement | null>(null);
  const titleTimeline = useRef<gsap.core.Timeline | null>(null);
  const [input, setInput] = useState('');
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(DEFAULT_SKIN_SETTINGS.muted);
  const [volume, setVolume] = useState(1);
  const [loginOpen, setLoginOpen] = useState(false);
  const [qr, setQr] = useState<LoginQr | null>(null);
  const [loginMessage, setLoginMessage] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  const noticeRef = useRef<string | null>(null);
  const stateRef = useRef<SkinState | null>(state);
  stateRef.current = state;
  noticeRef.current = notice;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const volumeRef = useRef(volume);
  volumeRef.current = volume;

  // 视频原始宽高比：metadata 加载完 / 切换清晰度后更新
  const updateVideoRatio = useCallback((video: HTMLVideoElement) => {
    const ratio = video.videoWidth > 0 && video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 0;
    setVideoRatio((previous) => (Math.abs(previous - ratio) < 0.0005 ? previous : ratio));
  }, []);

  // 确保媒体元素的声音状态与 HUD 一致（自动播放/重新挂载时尤其重要）
  const applyMediaSettings = useCallback(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (video) {
      // 有独立音轨时 video 必须静音，避免原生 durl 的内嵌音轨和 audio 双响。
      video.muted = mutedRef.current || Boolean(audio);
      video.volume = volumeRef.current;
    }
    if (audio) {
      audio.muted = mutedRef.current;
      audio.volume = volumeRef.current;
    }
  }, []);

  const notePlayError = useCallback((error: unknown) => {
    const name = errorName(error);
    // 暂停/切源会打断 play()，这是正常 AbortError，不能弹“被阻止”提示。
    if (name === 'AbortError') {
      return;
    }
    mediaErrorRef.current = toMessage(error);
    if (name === 'NotAllowedError') {
      setAudioBlocked(true);
    }
  }, []);

  const requestedKey = useRef('');
  const loadSeq = useRef(0);
  const audioSwitching = useRef(false);
  const audioFallbackRef = useRef(false);
  const visibleRef = useRef(true);
  const mediaErrorRef = useRef<string | null>(null);
  const backupIndex = useRef(0);
  const pendingSeek = useRef(0);
  /** 最近一次切换视频源的时间：切换瞬间的 error 多半是上一个请求被 abort */
  const srcChangedAt = useRef(0);
  const errorRetryTimer = useRef<number | undefined>(undefined);
  const initialized = useRef(false);
  const lastAuthRevision = useRef<number | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const pendingSave = useRef<Partial<SkinSettings>>({});
  // 独立音轨是扩展宿主转码后的 MP3/WAV：VS Code 的 libffmpeg 没有 AAC 解码器，
  // 直接把 B 站 m4s 交给 <audio> 会报 DEMUXER_ERROR_NO_SUPPORTED_STREAMS。
  const audioBackupIndex = useRef(0);
  const audioWavTried = useRef(false);
  const audioPlayPending = useRef(false);
  const lastAudioSeek = useRef(0);
  const mediaLogAt = useRef<Record<string, number>>({});
  const logClient = useCallback(
    (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => {
      api.log({ level, message, data });
    },
    [api],
  );

  const refreshState = useCallback(async () => {
    try {
      const next = await api.state();
      setState(next);
      return next;
    } catch {
      return undefined;
    }
  }, [api]);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let failures = 0;

    const tick = async () => {
      if (disposed) {
        return;
      }
      const next = await refreshState();
      if (disposed) {
        return;
      }
      if (next) {
        failures = 0;
      } else {
        failures += 1;
        // 挂载前已经探测过服务；这里连续拿不到状态（令牌失效/服务挂了）就别无限重试。
        if (!stateRef.current && failures >= 15) {
          return;
        }
      }
      timer = window.setTimeout(tick, 2000);
    };

    void tick();
    return () => {
      disposed = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [refreshState]);

  useEffect(() => {
    if (!state || initialized.current) {
      return;
    }
    initialized.current = true;
    setSettings(state.settings);
    setMuted(state.settings.muted);
    const video = state.video;
    setInput(video ? (video.bvid ?? `av${video.aid ?? ''}`) : '');
  }, [state]);

  const connected = state !== null;

  useEffect(() => {
    if (!connected) {
      return;
    }
    try {
      window.localStorage.setItem(PANEL_PREF_KEY, open ? 'open' : 'pill');
    } catch {
      // 隐私模式写不了 localStorage 时只是不记忆开合状态
    }
  }, [open, connected]);

  const load = useCallback(
    async (ref: VideoRef, qn: number): Promise<PlayInfo | null> => {
      const seq = ++loadSeq.current;
      // 关键生命周期：先标记切换中并暂停/卸载旧音轨。
      // 否则加载期间 250ms 的 syncAudio 会把刚暂停的旧 audio 重新 play，
      // 等新音轨挂载后旧 audio 已被卸载，却可能作为 detached element 继续出声。
      audioSwitching.current = true;
      audioBackupIndex.current = 0;
      audioWavTried.current = false;
      audioFallbackRef.current = false;
      audioRef.current?.pause();
      bufferingRef.current = false;
      setBuffering(false);
      readyPromptedRef.current = false;
      startedRef.current = false;
      hasPlayedRef.current = false;
      toast.dismiss('bili-ready');
      setAudioReady(false);
      setAudioSrc(null);
      mediaErrorRef.current = null;
      setLoading(true);
      setError(null);
      setNotice(null);
      try {
        const next = await api.play(ref, qn);
        if (seq !== loadSeq.current) {
          return null;
        }
        setInfo(next);
        setSrcUrl(next.url);
        setAudioSrc(next.audioUrl ?? null);
        backupIndex.current = 0;
        setDuration(next.duration || 0);
        audioSwitching.current = false;
        return next;
      } catch (loadError) {
        if (seq === loadSeq.current) {
          audioSwitching.current = false;
          setError(toMessage(loadError));
        }
        return null;
      } finally {
        if (seq === loadSeq.current) {
          setLoading(false);
        }
      }
    },
    [api],
  );

  const handleAudioError = useCallback(() => {
    const audio = audioRef.current;
    logClient('error', 'audio element error', {
      code: audio?.error?.code ?? null,
      message: audio?.error?.message ?? '',
      src: (audio?.currentSrc || audio?.getAttribute('src') || '').slice(0, 180),
      readyState: audio?.readyState,
      networkState: audio?.networkState,
    });
    if (audio?.error) {
      mediaErrorRef.current = `audio error ${audio.error.code}: ${audio.error.message}`;
    }
    setNotice(null);
    // MP3 解不了时退回 PCM WAV（VS Code 一定能解码）。
    if (!audioWavTried.current && info?.audioUrl && !info.audioUrl.includes('format=wav')) {
      audioWavTried.current = true;
      audioSwitching.current = false;
      setAudioSrc(`${info.audioUrl}&format=wav`);
      return;
    }
    const backup = info?.audioBackupUrls?.[audioBackupIndex.current];
    if (backup) {
      audioBackupIndex.current += 1;
      audioSwitching.current = false;
      setAudioSrc(backup);
      return;
    }
    // 原生模式下外置音轨失败：退回视频内嵌音轨（本机若缺 AAC 解码器仍然静音）。
    if (info?.mode === 'native' && info.audioUrl) {
      setAudioSrc(null);
      setNotice('独立音轨不可用，已使用视频内音轨（VS Code 可能无法解码 AAC）');
      return;
    }
    // 高清音轨失败时回退 720P，至少减少带宽。
    if (info && info.quality > 64 && !audioFallbackRef.current) {
      audioFallbackRef.current = true;
      setNotice('音轨播放失败，已切换到 720P');
      void load({ bvid: info.bvid, page: info.page }, 64);
      return;
    }
    setAudioBlocked(false);
    setError('音轨播放失败：请确认已安装 ffmpeg（macOS 也可用系统 afconvert）');
  }, [info, load, logClient]);

  const refreshPlayInfo = useCallback(() => {
    const ref = stateRef.current?.video;
    if (!ref || !visibleRef.current) {
      return;
    }
    pendingSeek.current = videoRef.current?.currentTime ?? 0;
    void load(ref, settingsRef.current.quality);
  }, [load]);

  const videoKey = state?.video
    ? `${state.video.bvid ?? `av${state.video.aid ?? ''}`}:${state.video.page ?? 1}`
    : '';

  // 还没连上本地服务时什么都不显示：卸载/禁用扩展后残留的注入不会弹出空设置面板。
  // 默认关闭时也不去拉 playurl / 转码音轨，等执行「开启」后再加载。
  const visible = state?.visible ?? false;
  visibleRef.current = visible;

  useEffect(() => {
    if (visible) {
      return;
    }
    // 关掉后允许下次「开启」重新加载同一个视频。
    requestedKey.current = '';
    videoRef.current?.pause();
    audioRef.current?.pause();
  }, [visible]);

  useEffect(() => {
    const ref = state?.video;
    if (!visible || !ref || !videoKey || requestedKey.current === videoKey) {
      return;
    }
    requestedKey.current = videoKey;
    setInput(ref.bvid ?? `av${ref.aid ?? ''}`);
    void load(ref, settingsRef.current.quality);
  }, [visible, videoKey, state, load]);

  useEffect(() => {
    document.body.classList.toggle('bili-skin-on', visible);
    return () => document.body.classList.remove('bili-skin-on');
  }, [visible]);

  // 隐藏播放模式 / 胶囊展开都依赖“鼠标是否在 HUD 上”。
  // 挂在 #bili-skin-hud 而不是 .bili-hud：Select 的 Portal 也在这个宿主里。
  useEffect(() => {
    const host = document.getElementById('bili-skin-hud');
    if (!host) {
      return;
    }
    const enter = () => setHudHovered(true);
    const leave = () => setHudHovered(false);
    host.addEventListener('pointerenter', enter);
    host.addEventListener('pointerleave', leave);
    return () => {
      host.removeEventListener('pointerenter', enter);
      host.removeEventListener('pointerleave', leave);
    };
  }, []);

  useEffect(() => {
    if (!visible) {
      setHudHovered(false);
    }
  }, [visible]);

  // 面板展开时胶囊保持宽条；收起/迷你状态完全由按钮控制，不再跟随 hover。
  useEffect(() => {
    if (open) {
      window.clearTimeout(pillExpandTimer.current);
      window.clearTimeout(pillCollapseTimer.current);
      setPillExpanding(false);
      setPillCollapsing(false);
      setPillWide(true);
    }
  }, [open]);

  // 自动播放策略：用户第一次点击/按键时，在真实手势里再尝试播放独立音轨/取消静音。
  useEffect(() => {
    const unlock = (event: Event) => {
      const target = event.target as Element | null;
      // 播放/静音按钮自己会在 React handler 里处理，避免 capture 阶段先 unlock 再被暂停。
      if (target?.closest('.bili-play-btn, .bili-icon-btn')) {
        return;
      }
      const video = videoRef.current;
      if (!video || video.paused) {
        return;
      }
      applyMediaSettings();
      if (!mutedRef.current) {
        void video.play().then(() => setAudioBlocked(false)).catch(notePlayError);
      }
      const audio = audioRef.current;
      if (audio?.error) {
        handleAudioError();
        return;
      }
      if (audio && audio.paused && !mutedRef.current) {
        void audio.play().then(() => setAudioBlocked(false)).catch(notePlayError);
      }
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    return () => {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    };
  }, [applyMediaSettings, notePlayError, handleAudioError]);

  // 把真实媒体状态报到本地 API，方便排查“有画面没声音/双音轨”问题。
  useEffect(() => {
    if (!visible) {
      return;
    }
    const read = (media: HTMLMediaElement | null) =>
      media
        ? {
            src: (media.currentSrc || media.getAttribute('src') || '').slice(-120),
            paused: media.paused,
            muted: media.muted,
            volume: media.volume,
            currentTime: Math.round(media.currentTime * 1000) / 1000,
            readyState: media.readyState,
            error: media.error ? media.error.code : null,
            errorMessage: media.error?.message,
            networkState: media.networkState,
            audioBytes: (media as HTMLMediaElement & { webkitAudioDecodedByteCount?: number })
              .webkitAudioDecodedByteCount,
          }
        : null;
    const report = () => {
      const video = videoRef.current;
      const audio = audioRef.current;
      const drift =
        video && audio ? Math.round((audio.currentTime - video.currentTime) * 1000) / 1000 : null;
      const foreign = Array.from(document.querySelectorAll<HTMLMediaElement>('video, audio'))
        .filter((media) => !media.closest('#bili-skin-video-host, #bili-skin-hud'))
        .map((media) => ({
          id: media.id,
          className: String(media.className).slice(0, 80),
          src: (media.currentSrc || media.getAttribute('src') || '').slice(0, 160),
          paused: media.paused,
          muted: media.muted,
          volume: media.volume,
          readyState: media.readyState,
        }));
      void api
        .diagnostics({
          at: Date.now(),
          visible,
          mode: info?.mode,
          quality: info?.quality,
          bvid: info?.bvid,
          playing,
          settingsMuted: settings.muted,
          stateMuted: muted,
          volume,
          drift,
          audioBlocked,
          mediaError: mediaErrorRef.current,
          video: read(video),
          audio: read(audio),
          foreign: foreign.slice(0, 12),
        })
        .catch(() => undefined);
    };
    report();
    const timer = window.setInterval(report, 2000);
    return () => window.clearInterval(timer);
  }, [api, visible, info, playing, settings.muted, muted, volume, audioBlocked]);

  // 旧版 douyinhelper/bilibilihelper 注入的 #bilibili-background-video 会盖住我们的视频。
  useEffect(() => {
    if (!visible) {
      return;
    }

    let previousDisplay: string | null = null;
    const silenceForeign = (): void => {
      // 其它 B 站播放入口（例如旧插件的后台 video）也不允许出声。
      document.querySelectorAll<HTMLMediaElement>('video, audio').forEach((media) => {
        if (media.closest('#bili-skin-video-host, #bili-skin-hud')) {
          return;
        }
        const src = media.currentSrc || media.getAttribute('src') || '';
        if (!/bilivideo|bilibili|mcdn|b23\.tv/i.test(src)) {
          return;
        }
        media.muted = true;
        if (!media.paused) {
          media.pause();
        }
      });
    };
    const silenceLegacy = (): boolean => {
      const legacy = document.getElementById('bilibili-background-video');
      if (!legacy) {
        return false;
      }
      if (previousDisplay === null) {
        previousDisplay = legacy.style.display;
      }
      legacy.style.display = 'none';
      // 只 display:none 不会停止播放；旧插件的 video 可能还在出声/和我们的视频不同步。
      legacy.querySelectorAll<HTMLMediaElement>('video, audio').forEach((media) => {
        media.muted = true;
        if (!media.paused) {
          media.pause();
        }
      });
      return true;
    };

    silenceLegacy();
    silenceForeign();
    // 旧插件可能在启动后几秒才注入，持续压住它的媒体；15s 后停止轮询。
    const timer = window.setInterval(() => {
      silenceLegacy();
      silenceForeign();
    }, 1000);
    const stop = window.setTimeout(() => window.clearInterval(timer), 15_000);

    return () => {
      window.clearInterval(timer);
      window.clearTimeout(stop);
      const legacy = document.getElementById('bilibili-background-video');
      if (legacy && previousDisplay !== null) {
        legacy.style.display = previousDisplay;
      }
    };
  }, [visible]);

  useEffect(() => {
    if (state?.openLogin) {
      setLoginOpen(true);
    }
  }, [state?.openLogin]);

  // 登录/退出后重新拉取 playurl，刷新清晰度列表
  useEffect(() => {
    if (!state) {
      return;
    }
    if (lastAuthRevision.current === null) {
      lastAuthRevision.current = state.authRevision;
      return;
    }
    if (lastAuthRevision.current !== state.authRevision) {
      lastAuthRevision.current = state.authRevision;
      refreshPlayInfo();
    }
  }, [state?.authRevision, state, refreshPlayInfo]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !srcUrl) {
      return;
    }

    applyMediaSettings();
    video.setAttribute('referrerpolicy', 'no-referrer');
    srcChangedAt.current = Date.now();
    hasPlayedRef.current = false;
    frameNudged.current = false;
    bufferingRef.current = false;
    setBuffering(false);
    window.clearTimeout(errorRetryTimer.current);
    video.load();

    const seek = pendingSeek.current;
    pendingSeek.current = 0;
    const onMetadata = () => {
      if (seek > 0 && Number.isFinite(video.duration)) {
        video.currentTime = Math.min(seek, Math.max(0, video.duration - 0.5));
      }
    };

    if (seek > 0) {
      video.addEventListener('loadedmetadata', onMetadata, { once: true });
    }

    if ((liveMode || settingsRef.current.autoplay) && visibleRef.current) {
      playRequestedAt.current = Date.now();
      void video.play()?.catch((error) => {
        // VS Code/Chromium 可能阻止带声音的自动播放；提醒用户点一下。
        if (settingsRef.current.muted === false) {
          notePlayError(error);
        }
      });
    }

    return () => video.removeEventListener('loadedmetadata', onMetadata);
  }, [srcUrl, liveMode, applyMediaSettings, notePlayError]);

  // 点播首次加载不自动播放：视频和音轨都准备好了，提示用户点播放。
  useEffect(() => {
    if (
      !visible ||
      liveMode ||
      !srcUrl ||
      playing ||
      buffering ||
      readyPromptedRef.current ||
      startedRef.current
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      if (!video || !video.paused || video.error || !info) {
        return;
      }
      const enough = video.readyState >= 3 || bufferedAhead(video) >= 2;
      const audioOk = !info.audioUrl || audioReady;
      if (!enough || !audioOk) {
        return;
      }
      readyPromptedRef.current = true;
      window.clearInterval(timer);
      toast(info.audioUrl ? '音频已就绪' : '视频已就绪', {
        id: 'bili-ready',
        description: '点击右下角播放按钮开始播放',
        duration: 8000,
        action: {
          label: '播放',
          onClick: () => {
            const current = videoRef.current;
            if (!current) {
              return;
            }
            startedRef.current = true;
            playRequestedAt.current = Date.now();
            void current.play().catch(() => undefined);
          },
        },
      });
    }, 500);
    return () => window.clearInterval(timer);
  }, [visible, liveMode, srcUrl, playing, buffering, info, audioReady]);

  // 环境检查：没装 ffmpeg 时视频没声音，Windows 上很常见
  useEffect(() => {
    let cancelled = false;
    void api.health().then((health) => {
      if (cancelled || !health || health.audioTranscoder) {
        return;
      }
      const hint =
        health.platform === 'win32'
          ? 'Windows 可运行 winget install Gyan.FFmpeg，装完重启 VS Code'
          : 'macOS 可运行 brew install ffmpeg';
      toast.warning(`没找到 ffmpeg：视频会只有画面没有声音。${hint}`, {
        id: 'bili-no-ffmpeg',
        duration: 10_000,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // 只有小屏模式才需要小屏设置面板
  useEffect(() => {
    if (settings.fit !== 'mini') {
      setMiniEditing(false);
      setMiniDraft(null);
    }
  }, [settings.fit]);

  // 小屏预览的可用宽度跟随面板宽度
  useEffect(() => {
    if (!miniEditing) {
      return;
    }
    const element = miniPreviewRef.current;
    if (!element) {
      return;
    }
    const sync = () => {
      setMiniPreviewWidth(element.clientWidth);
      setMiniPreviewHeight(element.clientHeight);
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, [miniEditing]);

  // 弹幕：打开后拉取整段弹幕，播放时把到时间的弹幕交给宿主打印到输出面板
  useEffect(() => {
    setDanmakuList(null);
    danmakuCursor.current = 0;
    danmakuLastTime.current = 0;
    if (!settings.danmaku || !info?.cid) {
      return;
    }
    let cancelled = false;
    void api
      .danmaku(info.cid)
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (result.ok) {
          setDanmakuList(result.items);
          logClient('info', 'danmaku loaded', { cid: info.cid, count: result.items.length });
        } else {
          logClient('error', 'danmaku load failed', { cid: info.cid });
        }
      })
      .catch((error: unknown) => {
        logClient('error', 'danmaku load failed', { message: toMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [api, settings.danmaku, info?.cid]);

  // 直播弹幕：轮询 B 站的历史弹幕接口，按 id 去重后打印到输出面板
  useEffect(() => {
    if (!liveMode || !liveRoom?.roomId || !settings.danmaku || liveRoom.liveStatus !== 1) {
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const result = await api.liveDanmaku(liveRoom.roomId);
        if (cancelled || !result.ok) {
          return;
        }
        const fresh = result.items.filter((item) => !liveSeenIds.current.has(item.id));
        for (const item of result.items) {
          liveSeenIds.current.add(item.id);
        }
        if (liveSeenIds.current.size > 800) {
          liveSeenIds.current = new Set(result.items.map((item) => item.id));
        }
        if (fresh.length > 0) {
          void api
            .emitDanmaku(
              fresh.slice(-8).map((item) => ({
                time: 0,
                text: item.nickname ? `${item.nickname}：${item.text}` : item.text,
              })),
              true,
            )
            .catch(() => undefined);
        }
      } catch {
        // 下一轮再试
      }
    };
    void poll();
    const timer = window.setInterval(poll, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [api, liveMode, liveRoom, settings.danmaku]);

  const emitDanmaku = useCallback(
    (time: number) => {
      const list = danmakuListRef.current;
      if (!list || list.length === 0) {
        return;
      }
      // 弹幕密集时 timeupdate 每 250ms 就有一条，攒一下再发，避免几十个请求/秒
      const now = Date.now();
      if (now - danmakuEmitAt.current < 400) {
        return;
      }
      const last = danmakuLastTime.current;
      danmakuLastTime.current = time;

      if (time < last - 1) {
        // 倒退/重播：重新定位游标，不补发已经过去的弹幕
        danmakuCursor.current = lowerBound(list, time);
        return;
      }

      const jumped = time - last > 4;
      let index = danmakuCursor.current;
      const batch: DanmakuItem[] = [];
      while (index < list.length && list[index].time <= time + 0.05) {
        const item = list[index];
        index += 1;
        // 拖动进度条/跳集后不补发一大串
        if (!jumped && time - item.time <= 4) {
          batch.push(item);
        }
        if (batch.length >= 8) {
          break;
        }
      }
      danmakuCursor.current = index;
      if (batch.length > 0) {
        danmakuEmitAt.current = now;
        void api.emitDanmaku(batch).catch(() => undefined);
      }
    },
    [api],
  );

  // 移除黑边：让扩展宿主用 ffmpeg 探测一次画面的真实宽高比（按 bvid:cid 缓存）。
  // 关闭时不用探测，直接按 <video> 自带的 videoWidth / videoHeight 排布。
  useEffect(() => {
    setContentAspect(0);
    if (!settings.cropBars || !info?.url || !info.cid) {
      return;
    }
    let cancelled = false;
    void api
      .contentAspect(info.url, `${info.bvid}:${info.cid}`, info.duration)
      .then((result) => {
        if (cancelled || !result.ok || typeof result.aspect !== 'number') {
          return;
        }
        // 明显离谱的比例说明探测失败，回退到视频原始比例
        if (result.aspect > 0.2 && result.aspect < 5) {
          setContentAspect(result.aspect);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, settings.cropBars, info?.bvid, info?.cid, info?.url, info?.duration]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = muted || Boolean(audioRef.current);
    }
    if (audioRef.current) {
      audioRef.current.muted = muted;
    }
  }, [muted]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
    }
    if (audioRef.current) {
      audioRef.current.volume = volume;
    }
  }, [volume]);

  useEffect(() => {
    setAudioReady(false);
  }, [audioSrc]);

  // 从 DASH 切回原生 mp4 时，确保旧的独立音轨被彻底停掉。
  useEffect(() => {
    if (audioSrc) {
      return;
    }
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }, [audioSrc]);

  // audio 的 src 变化时强制重新加载，避免复用旧元素时仍播上一段音轨。
  useEffect(() => {
    if (!audioSrc) {
      return;
    }
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    audio.setAttribute('referrerpolicy', 'no-referrer');
    audio.load();
    applyMediaSettings();
  }, [audioSrc, applyMediaSettings]);

  // DASH 是独立音轨：audio 必须严格跟随 video 的播放/暂停/进度。
  const syncAudio = useCallback(
    function sync() {
      const video = videoRef.current;
      const audio = audioRef.current;
      if (!video || !audio || !audio.getAttribute('src') || audioSwitching.current) {
        return;
      }
      if (!audio.isConnected) {
        audio.pause();
        return;
      }
      applyMediaSettings();

      // video 暂停/结束，audio 必须立刻停；否则会出现“暂停了声音还在放”。
      if (video.paused || video.ended) {
        audio.pause();
        return;
      }

      // 卡顿/缓冲中：不要让独立音轨继续往前走，否则 250ms 同步会把
      // audio.currentTime 反复 seek 回 video.currentTime，听感就是一小段音频在循环。
      if (bufferingRef.current) {
        audio.pause();
        return;
      }
      if (video.seeking || video.readyState < 2 || bufferedAhead(video) < 0.2) {
        audio.pause();
        return;
      }

      if (audio.readyState < 1 || audio.seeking) {
        return;
      }

      // 只在明显漂移时 seek。之前 force 每次 canplay 都写 currentTime，
      // 会触发 seek -> canplay -> seek 的死循环，几秒内打出上万条事件把渲染进程拖死。
      const drift = audio.currentTime - video.currentTime;
      const now = Date.now();
      // 最少间隔 1s，避免 seek -> canplay -> seek 的反馈环把渲染进程拖死。
      if (Math.abs(drift) > 0.3 && !audio.seeking && now - lastAudioSeek.current > 1000) {
        lastAudioSeek.current = now;
        try {
          audio.currentTime = video.currentTime;
        } catch {
          // 音频尚未可 seek
        }
      }
      if (audio.playbackRate !== 1) {
        audio.playbackRate = 1;
      }
      if (audio.paused && !audioPlayPending.current) {
        audioPlayPending.current = true;
        void audio
          .play()
          .then(() => {
            setAudioBlocked(false);
            if (noticeRef.current) {
              setNotice(null);
            }
          })
          .catch(notePlayError)
          .finally(() => {
            audioPlayPending.current = false;
          });
      }
    },
    [applyMediaSettings, notePlayError],
  );

  /** 数据够了再恢复；不够就让 video 保持暂停，避免“播 0.2s 又卡”的抖动。 */
  const tryResume = useCallback(() => {
    const video = videoRef.current;
    if (!video || !bufferingRef.current || video.seeking || video.error) {
      return;
    }
    const ahead = bufferedAhead(video);
    const remaining = Number.isFinite(video.duration)
      ? Math.max(0, video.duration - video.currentTime)
      : Number.POSITIVE_INFINITY;
    // 直播的缓冲窗口本来就短，等 2.5s 会一直起不来。
    const target = liveMode ? 1.2 : BUFFER_AHEAD_SECONDS;
    const need = Math.min(target, Math.max(0.6, remaining - 0.4));
    if (ahead < need && video.readyState < 4) {
      return;
    }
    bufferingRef.current = false;
    setBuffering(false);
    playRequestedAt.current = Date.now();
    void video.play().catch(() => {
      // 自动播放限制/用户刚暂停：回到暂停态，下一轮再试
    });
  }, [liveMode]);

  /** 卡住：暂停 video 和音轨，显示 spinner，等缓冲区够再恢复。 */
  const handleWaiting = useCallback(() => {
    const video = videoRef.current;
    // 预加载/用户暂停时也会触发 waiting，别把它当成卡顿。
    if (!video || video.paused || video.ended || video.error) {
      return;
    }
    bufferingRef.current = true;
    setBuffering(true);
    audioRef.current?.pause();
    // 首帧/首次缓冲阶段调用 pause() 会让 play() 的 Promise 以
    // AbortError（“The play() request was interrupted by a call to pause()”）结束，
    // 用户看到的就是“播放失败”。还没真正播起来就先让它继续缓冲。
    if (!hasPlayedRef.current) {
      return;
    }
    // 用户刚点播放 / 刚 seek 完也让缓冲自然进行，别立刻打断。
    if (Date.now() - playRequestedAt.current < 1200) {
      return;
    }
    video.pause();
  }, []);

  // 缓冲期间 progress 不一定及时，额外轮询一次缓冲区。
  useEffect(() => {
    if (!buffering) {
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      tryResume();
      const video = videoRef.current;
      // 20s 还拿不到任何画面数据：别再让按钮一直锁在“加载中”，
      // 让用户可以再点一次播放（或点重试重新拉地址）。
      if (video && video.readyState < 2 && Date.now() - startedAt > 20_000) {
        bufferingRef.current = false;
        setBuffering(false);
      }
    }, 400);
    return () => window.clearInterval(timer);
  }, [buffering, tryResume]);

  // timeupdate 只有 ~4Hz，额外用 250ms 轮询兜住漂移/暂停边界。
  useEffect(() => {
    if (!audioSrc) {
      return;
    }
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      if (video && !video.paused && !video.ended) {
        syncAudio();
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [audioSrc, syncAudio]);

  useEffect(() => {
    return () => {
      window.clearTimeout(pillExpandTimer.current);
      window.clearTimeout(pillCollapseTimer.current);
      window.clearTimeout(errorRetryTimer.current);
      titleTimeline.current?.kill();
    };
  }, []);

  // 把渲染进程里的未捕获错误也写进日志，方便排查“点了没反应/报错未找到”。
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      logClient('error', 'window error', {
        message: event.message,
        filename: event.filename,
        line: event.lineno,
        column: event.colno,
        stack: event.error instanceof Error ? event.error.stack?.slice(0, 1200) : undefined,
      });
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      logClient('error', 'unhandled rejection', {
        reason:
          reason instanceof Error
            ? `${reason.name}: ${reason.message}`
            : typeof reason === 'string'
              ? reason
              : safeJson(reason),
        stack: reason instanceof Error ? reason.stack?.slice(0, 1200) : undefined,
      });
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, [logClient]);

  const describeMedia = (media: HTMLMediaElement) => ({
    src: (media.currentSrc || media.getAttribute('src') || '').slice(0, 180),
    readyState: media.readyState,
    networkState: media.networkState,
    paused: media.paused,
    muted: media.muted,
    volume: media.volume,
    error: media.error ? { code: media.error.code, message: media.error.message } : null,
    audioBytes: (media as HTMLMediaElement & { webkitAudioDecodedByteCount?: number })
      .webkitAudioDecodedByteCount,
  });

  // 关键媒体事件全部落盘，出问题时能直接看到加载/解码在哪一步断掉。
  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    // 只保留关键事件：canplay/loadstart 这类每次加载/拖动都会刷，日志涨得太快
    const events = ['loadedmetadata', 'playing', 'pause', 'waiting', 'error'];
    const handler = (event: Event) => {
      const media = event.currentTarget as HTMLMediaElement;
      if (event.type !== 'error') {
        const now = Date.now();
        const key = `video:${event.type}`;
        if (now - (mediaLogAt.current[key] ?? 0) < 1000) {
          return;
        }
        mediaLogAt.current[key] = now;
      }
      logClient(event.type === 'error' ? 'error' : 'info', `video ${event.type}`, describeMedia(media));
    };
    for (const name of events) {
      video.addEventListener(name, handler);
    }
    return () => {
      for (const name of events) {
        video.removeEventListener(name, handler);
      }
    };
  }, [srcUrl, logClient]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    const events = ['loadstart', 'loadedmetadata', 'canplay', 'playing', 'pause', 'error', 'stalled', 'emptied'];
    const handler = (event: Event) => {
      const media = event.currentTarget as HTMLMediaElement;
      if (event.type !== 'error') {
        const now = Date.now();
        const key = `audio:${event.type}`;
        if (now - (mediaLogAt.current[key] ?? 0) < 1000) {
          return;
        }
        mediaLogAt.current[key] = now;
      }
      logClient(event.type === 'error' ? 'error' : 'info', `audio ${event.type}`, describeMedia(media));
    };
    for (const name of events) {
      audio.addEventListener(name, handler);
    }
    return () => {
      for (const name of events) {
        audio.removeEventListener(name, handler);
      }
    };
  }, [audioSrc, logClient]);

  // HUD 也要贴住编辑区右下角（真正定位的是 main.tsx 创建的 #bili-skin-hud 宿主）
  useEffect(() => {
    const host = document.getElementById('bili-skin-hud');
    if (!host) {
      return;
    }
    if (!editorBounds) {
      host.style.right = '';
      host.style.bottom = '';
      return;
    }
    host.style.right = `${Math.max(12, window.innerWidth - editorBounds.right + 18)}px`;
    host.style.bottom = `${Math.max(12, window.innerHeight - editorBounds.bottom + 18)}px`;
    return () => {
      host.style.right = '';
      host.style.bottom = '';
    };
  }, [editorBounds]);

  // 视频只铺编辑区：跟随编辑器内容区域的大小和位置
  useEffect(() => {
    let disposed = false;
    let target: HTMLElement | null = null;
    let observer: ResizeObserver | undefined;
    let stickyWidget: HTMLElement | null = null;
    let stickyObserver: ResizeObserver | undefined;

    const findTarget = () =>
      document.querySelector<HTMLElement>('.monaco-workbench .part.editor > .content') ??
      document.querySelector<HTMLElement>('.monaco-workbench .part.editor');

    const measure = () => {
      if (disposed) {
        return;
      }
      if (!target || !target.isConnected) {
        target = findTarget();
        if (target) {
          observer?.observe(target);
        }
      }
      if (!target) {
        return;
      }
      const rect = target.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) {
        return;
      }

      // 视频从代码文本区的上边缘开始：让出标签栏（content 里可能包含它）和面包屑，
      // 否则画面顶部会被它们盖住。
      let inset = 0;
      for (const editor of Array.from(target.querySelectorAll<HTMLElement>('.editor-container'))) {
        const editorRect = editor.getBoundingClientRect();
        if (editorRect.width > 2 && editorRect.height > 2) {
          inset = Math.max(inset, editorRect.top - rect.top);
        }
      }
      if (inset <= 0) {
        // 没有 .editor-container 时退回到面包屑底边
        for (const crumbs of Array.from(target.querySelectorAll<HTMLElement>('.breadcrumbs-control'))) {
          const crumbsRect = crumbs.getBoundingClientRect();
          if (crumbsRect.width > 2 && crumbsRect.height > 2) {
            inset = Math.max(inset, crumbsRect.bottom - rect.top);
          }
        }
      }
      // 至少留一点空隙，别贴着上边缘
      inset = Math.max(inset, 8);
      setTopInset((previous) => (Math.abs(previous - inset) < 0.5 ? previous : Math.round(inset)));

      // 吸顶滚动（方法栏）出现时会盖住视频顶部：实时量它的高度，让视频整体下移
      if (!stickyWidget || !stickyWidget.isConnected) {
        stickyWidget = target.querySelector<HTMLElement>('.monaco-editor .sticky-widget');
        if (stickyWidget) {
          stickyObserver?.disconnect();
          stickyObserver = new ResizeObserver(measure);
          stickyObserver.observe(stickyWidget);
        }
      }
      const stickyRect = stickyWidget?.getBoundingClientRect();
      const stickyStyle = stickyWidget ? getComputedStyle(stickyWidget) : null;
      const stickyHidden =
        !stickyStyle || stickyStyle.display === 'none' || stickyStyle.visibility === 'hidden';
      const sticky = !stickyHidden && stickyRect && stickyRect.height > 2 ? Math.round(stickyRect.height) : 0;
      setStickyHeight((previous) => (previous === sticky ? previous : sticky));

      // 右侧代码地图（minimap）会盖在视频上：把视频右边界收窄到 minimap 左缘。
      // 取最靠右、且贴着编辑器右缘的那一个，兼容分屏和 minimap 在左侧的配置。
      let right = rect.right;
      for (const minimap of Array.from(target.querySelectorAll<HTMLElement>('.minimap'))) {
        const minimapRect = minimap.getBoundingClientRect();
        if (minimapRect.width < 8 || minimapRect.height < 8) {
          continue;
        }
        if (minimapRect.right < rect.right - 60) {
          continue;
        }
        right = Math.min(right, minimapRect.left);
      }
      const width = Math.max(2, right - rect.left);
      setMinimapWidth((previous) => {
        const next = Math.max(0, Math.round(rect.right - right));
        return Math.abs(previous - next) < 0.5 ? previous : next;
      });

      setEditorBounds((previous) => {
        if (
          previous &&
          Math.abs(previous.left - rect.left) < 0.5 &&
          Math.abs(previous.top - rect.top) < 0.5 &&
          Math.abs(previous.width - width) < 0.5 &&
          Math.abs(previous.height - rect.height) < 0.5
        ) {
          return previous;
        }
        return {
          left: rect.left,
          top: rect.top,
          width,
          height: rect.height,
          right: rect.left + width,
          bottom: rect.bottom,
        };
      });
    };

    observer = new ResizeObserver(measure);
    const workbench = document.querySelector('.monaco-workbench');
    if (workbench) {
      observer.observe(workbench);
    }
    target = findTarget();
    if (target) {
      observer.observe(target);
    }
    measure();

    const interval = window.setInterval(measure, 1000);
    window.addEventListener('resize', measure);

    return () => {
      disposed = true;
      observer?.disconnect();
      stickyObserver?.disconnect();
      window.clearInterval(interval);
      window.removeEventListener('resize', measure);
    };
  }, []);

  const persistSettings = useCallback(
    (patch: Partial<SkinSettings>) => {
      pendingSave.current = { ...pendingSave.current, ...patch };
      if (saveTimer.current !== undefined) {
        window.clearTimeout(saveTimer.current);
      }
      saveTimer.current = window.setTimeout(() => {
        const payload = pendingSave.current;
        pendingSave.current = {};
        void api.patch({ settings: payload }).catch(() => undefined);
      }, 350);
    },
    [api],
  );

  const updateSettings = useCallback(
    (patch: Partial<SkinSettings>) => {
      setSettings((previous) => ({ ...previous, ...patch }));
      persistSettings(patch);
    },
    [persistSettings],
  );

  const { contextSafe } = useGSAP(
    () => {
      if (!loginOpen) {
        return;
      }
      const timeline = gsap.timeline();
      if (modalOverlayRef.current) {
        timeline.from(modalOverlayRef.current, { autoAlpha: 0, duration: REDUCED_MOTION ? 0 : 0.18 }, 0);
      }
      if (modalRef.current) {
        timeline.from(
          modalRef.current,
          { autoAlpha: 0, y: 8, scale: 0.96, duration: REDUCED_MOTION ? 0 : 0.2, ease: 'power2.out' },
          0,
        );
      }
    },
    { scope: hudRootRef, dependencies: [loginOpen], revertOnUpdate: true },
  );

  /**
   * 宽胶囊 → 迷你胶囊：保持宽胶囊内容，宽度从右往左收缩、内容被裁掉，
   * 动画结束后再切换到迷你按钮（和展开动画互为逆过程）。
   */
  const collapsePill = useCallback(() => {
    window.clearTimeout(pillExpandTimer.current);
    setPillExpanding(false);
    if (!pillWide || pillCollapsing) {
      return;
    }
    setPillCollapsing(true);
    window.clearTimeout(pillCollapseTimer.current);
    pillCollapseTimer.current = window.setTimeout(() => {
      setPillCollapsing(false);
      setPillWide(false);
    }, PILL_MOTION_MS);
  }, [pillWide, pillCollapsing]);

  /**
   * 胶囊 → 面板：先把面板压成胶囊大小并模糊内容，再放大到完整尺寸并解除模糊。
   * 锚点在右下角，所以看起来是从胶囊里“长”出来。
   */
  const expandPanel = contextSafe(() => {
    if (open) {
      return;
    }
    if (REDUCED_MOTION || !pillRef.current) {
      setOpen(true);
      return;
    }
    // 用布局尺寸而不是 getBoundingClientRect：胶囊可能正在做缩放动画。
    pendingExpandFrom.current = {
      width: pillRef.current.offsetWidth,
      height: pillRef.current.offsetHeight,
    };
    setOpen(true);
  });

  /**
   * 面板 → 胶囊：内容先模糊，面板压缩到胶囊矩形，切换后胶囊由模糊变清晰。
   */
  const collapsePanel = contextSafe(() => {
    if (!open) {
      return;
    }
    const panel = panelRef.current;
    const pill = pillRef.current;
    if (!panel || !pill || REDUCED_MOTION) {
      setOpen(false);
      return;
    }
    // 只动画面板高度，内容保持原始布局；超出部分由 overflow:hidden 裁掉，
    // 不做 scale，避免设置项在收起过程中被纵向压扁。
    const fromHeight = panel.offsetHeight;
    const toHeight = pill.offsetHeight;
    if (fromHeight < 1 || toHeight < 1) {
      setOpen(false);
      return;
    }

    morphRef.current?.kill();
    const content = panelContentRef.current;
    const timeline = gsap.timeline({
      onComplete: () => {
        pendingCollapseIn.current = true;
        setOpen(false);
      },
    });
    morphRef.current = timeline;

    if (content) {
      timeline.to(content, { filter: 'blur(9px)', opacity: 0.6, duration: 0.18, ease: 'power1.out' }, 0);
      timeline.to(content, { opacity: 0, duration: 0.24, ease: 'power1.in' }, 0.22);
    }
    gsap.set(panel, { height: fromHeight, overflow: 'hidden' });
    timeline.to(
      panel,
      {
        height: toHeight,
        duration: 0.5,
        ease: 'power3.inOut',
      },
      0.05,
    );
  });

  // 状态切换发生在 layout 阶段，先量目标尺寸再补动画，避免闪一帧。
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }

    if (!open) {
      gsap.set(panel, { clearProps: 'height' });
    }

    if (open && pendingExpandFrom.current) {
      const from = pendingExpandFrom.current;
      pendingExpandFrom.current = null;
      morphRef.current?.kill();
      // 上一次收起可能留下了高度/缩放，先清掉才能量到完整尺寸。
      gsap.set(panel, { clearProps: 'transform,transformOrigin,height' });
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      if (width < 1 || height < 1) {
        return;
      }

      const content = panelContentRef.current;
      // 从胶囊高度开始长高，内容不缩放，只在可视区域内逐渐露出来。
      gsap.set(panel, { height: from.height, overflow: 'hidden' });
      if (content) {
        gsap.set(content, { filter: 'blur(12px)', opacity: 0.5 });
      }

      const timeline = gsap.timeline({
        onComplete: () => {
          gsap.set(panel, { clearProps: 'height,transform,transformOrigin' });
          if (content) {
            gsap.set(content, { clearProps: 'filter,opacity' });
          }
        },
      });
      morphRef.current = timeline;
      if (content) {
        timeline.to(content, { filter: 'blur(5px)', opacity: 1, duration: 0.2, ease: 'power1.out' }, 0);
        timeline.to(content, { filter: 'blur(0px)', duration: 0.26, ease: 'power2.out' }, 0.2);
      }
      timeline.to(panel, { height, duration: 0.5, ease: 'power3.out' }, 0);
      return;
    }

    if (!open && pendingCollapseIn.current) {
      pendingCollapseIn.current = false;
      const pill = pillRef.current;
      const content = pillContentRef.current;
      if (!pill) {
        return;
      }
      morphRef.current?.kill();
      if (content) {
        gsap.fromTo(
          content,
          { filter: 'blur(8px)', opacity: 0.4 },
          {
            filter: 'blur(0px)',
            opacity: 1,
            duration: 0.24,
            ease: 'power2.out',
            clearProps: 'filter,opacity',
          },
        );
      }
      gsap.fromTo(
        pill,
        { scaleX: 0.97, scaleY: 0.9 },
        { scaleX: 1, scaleY: 1, duration: 0.26, ease: 'power3.out', clearProps: 'transform' },
      );
    }
  }, [open]);

  useEffect(
    () => () => {
      morphRef.current?.kill();
    },
    [],
  );

  const closeLogin = contextSafe(() => {
    if (!loginOpen) {
      return;
    }
    if (!modalRef.current || !modalOverlayRef.current || REDUCED_MOTION) {
      setLoginOpen(false);
      setQr(null);
      return;
    }
    gsap.to(modalOverlayRef.current, { autoAlpha: 0, duration: 0.14 });
    gsap.to(modalRef.current, {
      autoAlpha: 0,
      scale: 0.97,
      y: 6,
      duration: 0.14,
      onComplete: () => {
        setLoginOpen(false);
        setQr(null);
      },
    });
  });

  const loadLiveInput = async (raw: string, qn?: number) => {
    const text = raw.trim();
    if (!text) {
      setError('请输入直播间链接或房间号');
      return;
    }
    setLiveLoading(true);
    setError(null);
    try {
      const result = await api.liveRoom(text, qn);
      if (!result.ok || !result.room) {
        setError(result.error ?? '直播间加载失败');
        toast.error(result.error ?? '直播间加载失败');
        return;
      }
      const room = result.room;
      liveSeenIds.current.clear();
      setLiveRoom(room);
      setInput(text);
      if (qn && room.currentQn && qn !== room.currentQn) {
        toast.info(`该清晰度当前不可用，已切换到${liveQualityLabel(room.currentQn)}`);
      }
      if (!room.streamUrl) {
        setSrcUrl(null);
        setAudioSrc(null);
        toast.warning('主播还没开播');
        return;
      }
      setInfo(null);
      setCurrentTime(0);
      setDuration(0);
      pendingSeek.current = 0;
      backupIndex.current = 0;
      setSrcUrl(api.liveStreamUrl(room.streamUrl, (room.videoCodec ?? 'avc') !== 'avc'));
      setAudioSrc(null);
      try {
        await api.patch({ visible: true });
      } catch {
        // 服务端不可用时静默重试
      }
    } finally {
      setLiveLoading(false);
    }
  };

  const changeLiveMode = (next: boolean) => {
    if (next === liveMode) {
      return;
    }
    setLiveMode(next);
    setError(null);
    liveSeenIds.current.clear();
    if (next) {
      // 切到直播：先停下当前视频，等用户贴直播间链接
      setLiveRoom(null);
      setInfo(null);
      setSrcUrl(null);
      setAudioSrc(null);
      videoRef.current?.pause();
      toast.info('直播模式：贴入直播间链接或房间号（如 live.bilibili.com/6）');
      return;
    }
    // 切回点播：恢复上次看的视频
    setLiveRoom(null);
    setInfo(null);
    setSrcUrl(null);
    setAudioSrc(null);
    setInput('');
    const ref = stateRef.current?.video;
    if (ref) {
      void load(ref, settingsRef.current.quality);
    }
  };

  const loadManual = async () => {
    if (liveMode) {
      await loadLiveInput(input);
      return;
    }
    const ref = parseVideoInput(input);
    if (!ref) {
      setError('无法识别 BV 号 / av 号 / 链接');
      return;
    }

    requestedKey.current = `${ref.bvid ?? `av${ref.aid ?? ''}`}:${ref.page ?? 1}`;
    const loaded = await load(ref, settings.quality);
    if (loaded) {
      try {
        await api.patch({ video: { bvid: ref.bvid, aid: ref.aid, page: ref.page }, visible: true });
      } catch {
        // 服务端不可用时静默重试
      }
    }
  };

  const changeQuality = async (qn: number) => {
    const ref = stateRef.current?.video;
    if (!ref) {
      return;
    }
    pendingSeek.current = videoRef.current?.currentTime ?? 0;
    updateSettings({ quality: qn });
    const next = await load(ref, qn);
    if (next && next.quality !== qn) {
      const label = next.qualities.find((quality) => quality.qn === next.quality)?.desc ?? `${next.quality}P`;
      setNotice(`该清晰度当前不可用，已切换到 ${label}`);
    }
  };

  const switchEpisode = async (index: number) => {
    const episode = info?.episodes?.[index];
    if (!episode || !info || index === info.episodeIndex) {
      return;
    }
    requestedKey.current = `${episode.bvid}:${episode.page}`;
    pendingSeek.current = 0;
    setInput(episode.bvid);
    const loaded = await load({ bvid: episode.bvid, page: episode.page }, settings.quality);
    if (loaded) {
      try {
        await api.patch({ video: { bvid: episode.bvid, page: episode.page }, visible: true });
      } catch {
        // 服务端不可用时静默重试
      }
    }
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    // 用户点击是手势，确保此时把静音/音量重新应用一次再 play，避免自动播放阶段被静音后一直无声。
    applyMediaSettings();
    if (video.paused) {
      playRequestedAt.current = Date.now();
      void video
        .play()
        .then(() => setAudioBlocked(false))
        .catch((error) => {
          // 缓冲还没起来时会被 waiting 里的 pause() 打断，这不算失败，
          // 继续等缓冲区够了自动播（spinner 已经在转）。
          if (isAbortError(error)) {
            return;
          }
          // play() 真的失败了（例如被浏览器拦截）：把加载态收掉，按钮要能再点。
          bufferingRef.current = false;
          setBuffering(false);
          notePlayError(error);
          setError(`播放失败：${toMessage(error)}`);
        });
    } else {
      video.pause();
      audioRef.current?.pause();
    }
  };

  const toggleMute = () => {
    const next = !muted;
    if (!next && volumeRef.current === 0) {
      setVolume(0.8);
      volumeRef.current = 0.8;
    }
    setMuted(next);
    updateSettings({ muted: next });
    const hasAudioTrack = Boolean(audioRef.current);
    if (videoRef.current) {
      videoRef.current.muted = next || hasAudioTrack;
      videoRef.current.volume = volumeRef.current;
    }
    if (audioRef.current) {
      audioRef.current.muted = next;
      audioRef.current.volume = volumeRef.current;
      if (!next) {
        void audioRef.current.play().then(() => setAudioBlocked(false)).catch(notePlayError);
      }
    }
    if (!next && videoRef.current && !videoRef.current.paused) {
      void videoRef.current.play().then(() => setAudioBlocked(false)).catch(notePlayError);
    }
  };

  const changeVolume = (next: number) => {
    const nextMuted = next === 0;
    setVolume(next);
    volumeRef.current = next;
    setMuted(nextMuted);
    updateSettings({ muted: nextMuted });
    const hasAudioTrack = Boolean(audioRef.current);
    if (videoRef.current) {
      videoRef.current.volume = next;
      videoRef.current.muted = nextMuted || hasAudioTrack;
    }
    if (audioRef.current) {
      audioRef.current.volume = next;
      audioRef.current.muted = nextMuted;
    }
  };

  // 标题 hover 溢出时来回滚动（没有溢出就不动）
  const startTitleScroll = () => {
    const wrap = pillTitleWrapRef.current;
    const inner = pillTitleRef.current;
    if (!wrap || !inner) {
      return;
    }
    const overflow = inner.scrollWidth - wrap.clientWidth;
    if (overflow <= 2) {
      return;
    }
    titleTimeline.current?.kill();
    const timeline = gsap.timeline({ repeat: -1, delay: 0.12 });
    timeline
      .to(inner, { x: -overflow, duration: Math.max(1.4, overflow / 30), ease: 'none' })
      .to({}, { duration: 1.1 })
      .to(inner, { x: 0, duration: Math.max(0.5, overflow / 90), ease: 'none' })
      .to({}, { duration: 0.45 });
    titleTimeline.current = timeline;
  };

  const stopTitleScroll = () => {
    titleTimeline.current?.kill();
    titleTimeline.current = null;
    if (pillTitleRef.current) {
      gsap.to(pillTitleRef.current, { x: 0, duration: 0.2, ease: 'power2.out', overwrite: true });
    }
  };

  const toggleDanmaku = () => {
    const next = !settings.danmaku;
    updateSettings({ danmaku: next });
    if (next) {
      toast.info('弹幕会按播放时间打印到「Bilibili 皮肤」输出面板');
    }
  };

  // 展开动画期间先别挂 Tooltip，否则鼠标扫过音量按钮会提前弹出来
  const canHoverVolume = pillWide && !open && !pillExpanding;
  const volumeTrigger = (
    <button
      type="button"
      className={`bili-icon-btn ${muted ? 'bili-muted' : ''}`}
      title={muted ? '取消静音' : '静音'}
      aria-label={muted ? '取消静音' : '静音'}
      onClick={toggleMute}
    >
      <Volume width={14} height={14} />
    </button>
  );

  const handleVideoError = () => {
    const video = videoRef.current;
    // 没有 media error 的 error 事件（迟到的 abort、合成事件）直接忽略
    if (!video || !video.error) {
      return;
    }

    // 切换视频/换清晰度时，浏览器会 abort 上一个请求，偶尔补一个迟到的 error。
    // 这种 error 不该触发“切换备用 CDN → 全部失败 → 报错”的连锁反应：
    // 先等 1.6s 再确认，如果这期间已经能播（readyState >= 1）就直接忽略。
    if (video && Date.now() - srcChangedAt.current < 900) {
      window.clearTimeout(errorRetryTimer.current);
      errorRetryTimer.current = window.setTimeout(() => {
        const current = videoRef.current;
        if (!current || !current.error || current.readyState >= 1) {
          return;
        }
        handleVideoError();
      }, 1100);
      return;
    }

    if (isLive) {
      setError('直播流中断，请重新加载直播间');
      toast.error('直播流中断，请重新加载直播间');
      return;
    }
    if (!info) {
      setError('视频加载失败');
      return;
    }
    const next = info.backupUrls[backupIndex.current];
    if (next) {
      backupIndex.current += 1;
      setSrcUrl(next);
      return;
    }
    setError('视频加载失败：CDN 链接可能已过期，请点击重试');
  };

  const refreshQr = useCallback(async () => {
    setLoginLoading(true);
    setLoginMessage('正在生成二维码…');
    try {
      const next = await api.loginQr();
      setQr(next);
      setLoginMessage('等待扫码');
    } catch (loginError) {
      setLoginMessage(toMessage(loginError));
    } finally {
      setLoginLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (loginOpen && !qr) {
      void refreshQr();
    }
  }, [loginOpen, qr, refreshQr]);

  useEffect(() => {
    if (!loginOpen || !qr) {
      return;
    }

    let disposed = false;
    const timer = window.setInterval(async () => {
      try {
        const result = await api.pollLogin(qr.key);
        if (disposed) {
          return;
        }
        if (result.status === 'success') {
          setLoginOpen(false);
          setQr(null);
          setLoginMessage('');
          await refreshState();
        } else if (result.status === 'expired') {
          setLoginMessage(result.message ?? '二维码已过期');
          window.clearInterval(timer);
        } else if (result.message) {
          setLoginMessage(result.message);
        }
      } catch (loginError) {
        if (!disposed) {
          setLoginMessage(toMessage(loginError));
        }
      }
    }, 2000);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [loginOpen, qr, api, refreshState]);

  const logout = async () => {
    try {
      await api.logout();
      await refreshState();
    } catch (logoutError) {
      setError(toMessage(logoutError));
    }
  };

  const retry = () => {
    const ref = state?.video ?? (info ? { bvid: info.bvid, page: info.page } : null);
    if (ref) {
      void load(ref, settings.quality);
    }
  };

  // 所有提示都走 sonner，不再往设置面板里塞 alert（否则会把面板撑高）。
  const audioPreparing = Boolean(audioSrc) && !audioReady;
  const busy = loading || audioPreparing || liveLoading;
  const isLightTheme =
    typeof document !== 'undefined' && document.body.classList.contains('vscode-light');

  useEffect(() => {
    if (!loading) {
      toast.dismiss('bili-loading');
      return;
    }
    // 缓存命中时几毫秒就好了，延迟一点再弹，避免 loading toast 闪一下。
    const timer = window.setTimeout(() => {
      toast.loading('正在加载视频…', { id: 'bili-loading', duration: Infinity });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [loading]);

  useEffect(() => {
    if (!audioPreparing) {
      toast.dismiss('bili-audio');
      return;
    }
    const timer = window.setTimeout(() => {
      toast.loading('正在同步音频，请稍后…', {
        id: 'bili-audio',
        duration: Infinity,
        description: '首次播放（或切换清晰度/视频）需要把 AAC 音轨转成可播放的 MP3，视频越长等待越久',
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [audioPreparing]);

  useEffect(() => {
    if (!notice) {
      toast.dismiss('bili-notice');
      return;
    }
    toast.info(notice, { id: 'bili-notice', duration: 4200 });
  }, [notice]);

  useEffect(() => {
    if (!error) {
      toast.dismiss('bili-error');
      return;
    }
    toast.error(error, {
      id: 'bili-error',
      duration: 8000,
      action: { label: '重试', onClick: retry },
    });
  }, [error, retry]);

  useEffect(() => {
    if (!audioBlocked) {
      toast.dismiss('bili-blocked');
      return;
    }
    toast.warning('VS Code 阻止了声音自动播放，点一下画面或喇叭图标即可开启声音', {
      id: 'bili-blocked',
      duration: 6000,
    });
  }, [audioBlocked]);

  // 隐藏播放模式：只有鼠标停在 HUD 上才应用用户设置的透明度/模糊/暗化；
  // 移开时 opacity=0、dim=1（暗化层完全盖住视频），编辑区回到正常颜色。
  const revealVideo = !settings.hiddenMode || hudHovered;
  const layerStyle = {
    left: editorBounds ? `${editorBounds.left}px` : '0px',
    top: editorBounds ? `${editorBounds.top}px` : '0px',
    width: editorBounds ? `${editorBounds.width}px` : '0px',
    height: editorBounds ? `${editorBounds.height}px` : '0px',
    visibility: editorBounds ? 'visible' : 'hidden',
    display: visible ? undefined : 'none',
    '--bili-opacity': revealVideo ? settings.opacity : 0,
    '--bili-blur': revealVideo ? `${settings.blur}px` : '0px',
    '--bili-dim': revealVideo ? settings.dim : 1,
  } as CSSProperties;

  /**
   * 完整模式：视频按画面宽高比在编辑区里排布。
   * - 宽度铺满编辑区，高度 = 宽度 / 宽高比
   * - 高度超出可用高度时反过来按高度缩放（保证完整可见）
   * - 顶部让出标签栏/面包屑的高度，横向居中，剩下的区域露出编辑器背景色
   */
  const ratio = contentAspect > 0 ? contentAspect : videoRatio > 0 ? videoRatio : 16 / 9;
  /** 视频内容区上边界：标签栏/面包屑 + 吸顶方法栏 */
  const contentTop = topInset + stickyHeight;
  const miniAvailableWidth = editorBounds ? Math.max(2, editorBounds.width) : 0;
  const miniAvailableHeight = editorBounds ? Math.max(2, editorBounds.height - contentTop) : 0;
  /** 预览里要一起画出来的完整编辑区（含 minimap 色块） */
  const miniStageWidth = miniAvailableWidth + minimapWidth;
  const miniStageHeight = editorBounds ? Math.max(2, editorBounds.height) : 0;

  // 小屏框：设置里存归一化位置，这里换算成编辑区内的像素并夹在可用区域里
  const miniRectFromSettings: MiniBoxRect | null = editorBounds
    ? (() => {
        const preferred = clampNumber(
          settings.miniRect.w * miniAvailableWidth,
          Math.min(MINI_MIN_WIDTH, miniAvailableWidth),
          miniAvailableWidth,
        );
        const width = Math.max(2, Math.min(preferred, miniAvailableHeight * ratio));
        const height = width / ratio;
        return {
          w: width,
          h: height,
          x: clampNumber(
            settings.miniRect.x * miniAvailableWidth,
            0,
            Math.max(0, miniAvailableWidth - width),
          ),
          y:
            contentTop +
            clampNumber(
              settings.miniRect.y * miniAvailableHeight,
              0,
              Math.max(0, miniAvailableHeight - height),
            ),
        };
      })()
    : null;
  const miniActiveRect = miniDraft ?? miniRectFromSettings;

  const miniPreviewScale =
    miniEditing && miniPreviewWidth > 0 && miniPreviewHeight > 0 && miniStageWidth > 0 && miniStageHeight > 0
      ? Math.min(miniPreviewWidth / miniStageWidth, miniPreviewHeight / miniStageHeight)
      : 0;

  const videoBox = (() => {
    if (!editorBounds) {
      return null;
    }
    if (settings.fit === 'mini') {
      if (!miniActiveRect) {
        return null;
      }
      return {
        left: Math.round(miniActiveRect.x),
        top: Math.round(miniActiveRect.y),
        width: Math.max(2, Math.round(miniActiveRect.w)),
        height: Math.max(2, Math.round(miniActiveRect.h)),
      };
    }
    const availableWidth = miniAvailableWidth;
    const availableHeight = miniAvailableHeight;
    let width = availableWidth;
    let height = width / ratio;
    if (height > availableHeight) {
      height = availableHeight;
      width = height * ratio;
    }
    return {
      left: Math.max(0, Math.round((availableWidth - width) / 2)),
      top: Math.round(contentTop),
      width: Math.max(2, Math.round(width)),
      height: Math.max(2, Math.round(height)),
    };
  })();

  // 进入小屏设置前记录配置页的高度，保证切换后设置页不会被撑高/缩矮
  const openMiniEditing = useCallback(() => {
    const height = normalBodyRef.current?.getBoundingClientRect().height ?? 0;
    setMiniBodyHeight(height > 48 ? Math.round(height) : null);
    setMiniEditing(true);
  }, []);

  const toggleMiniEditing = () => {
    if (miniEditing) {
      setMiniEditing(false);
      return;
    }
    openMiniEditing();
  };

  // 拖动小屏时在设置面板上“开个洞”：中间逐渐透明，能看到背后被毛玻璃模糊的画面
  const applyPanelPeek = (rect: MiniBoxRect) => {
    const panel = panelRef.current;
    if (!panel || !editorBounds) {
      return;
    }
    const panelRect = panel.getBoundingClientRect();
    const centerX = editorBounds.left + rect.x + rect.w / 2 - panelRect.left;
    const centerY = editorBounds.top + rect.y + rect.h / 2 - panelRect.top;
    panel.style.setProperty('--bili-peek-x', `${Math.round(centerX)}px`);
    panel.style.setProperty('--bili-peek-y', `${Math.round(centerY)}px`);
    panel.style.setProperty('--bili-peek-r', `${Math.round(Math.max(rect.w, rect.h) * 0.7)}px`);
    panel.dataset.peek = 'true';
  };

  const clearPanelPeek = () => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    delete panel.dataset.peek;
    panel.style.removeProperty('--bili-peek-x');
    panel.style.removeProperty('--bili-peek-y');
    panel.style.removeProperty('--bili-peek-r');
  };

  // 小屏框：拖动移动，左下角缩放（右上角锚定，宽高比锁定）
  const startMiniGesture =
    (mode: 'move' | 'resize') => (event: ReactPointerEvent<HTMLElement>) => {
      if (!miniActiveRect || !editorBounds) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      miniGesture.current = {
        mode,
        startX: event.clientX,
        startY: event.clientY,
        rect: { ...miniActiveRect },
        scale: miniPreviewScale > 0 ? miniPreviewScale : 1,
      };
      try {
        miniBoxRef.current?.setPointerCapture(event.pointerId);
      } catch {
        // 合成事件/指针已释放时可能失败，不影响后续 pointermove
      }
      setMiniDraft({ ...miniActiveRect });
      applyPanelPeek(miniActiveRect);
    };

  const moveMiniGesture = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = miniGesture.current;
    if (!gesture || !editorBounds) {
      return;
    }
    const dx = (event.clientX - gesture.startX) / gesture.scale;
    const dy = (event.clientY - gesture.startY) / gesture.scale;
    const minTop = contentTop;
    const maxBottom = contentTop + miniAvailableHeight;

    if (gesture.mode === 'move') {
      const next = {
        ...gesture.rect,
        x: clampNumber(gesture.rect.x + dx, 0, Math.max(0, miniAvailableWidth - gesture.rect.w)),
        y: clampNumber(gesture.rect.y + dy, minTop, Math.max(minTop, maxBottom - gesture.rect.h)),
      };
      setMiniDraft(next);
      applyPanelPeek(next);
      return;
    }

    // 缩放：右上角不动，宽度变化时高度按比例跟着变
    const right = gesture.rect.x + gesture.rect.w;
    const top = gesture.rect.y;
    let width = gesture.rect.w - dx;
    width = Math.min(width, right);
    width = Math.min(width, (maxBottom - top) * ratio);
    width = Math.max(Math.min(MINI_MIN_WIDTH, miniAvailableWidth), width);
    const next = { x: right - width, y: top, w: width, h: width / ratio };
    setMiniDraft(next);
    applyPanelPeek(next);
  };

  const finishMiniGesture = (event: ReactPointerEvent<HTMLElement>) => {
    if (!miniGesture.current) {
      return;
    }
    miniGesture.current = null;
    clearPanelPeek();
    try {
      miniBoxRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      // 指针已经不存在时忽略
    }
    const rect = miniDraftRef.current ?? miniActiveRect;
    setMiniDraft(null);
    if (!rect) {
      return;
    }
    updateSettings({
      miniRect: {
        x: clampNumber(rect.x / miniAvailableWidth, 0, 1),
        y: clampNumber((rect.y - contentTop) / miniAvailableHeight, 0, 1),
        w: clampNumber(rect.w / miniAvailableWidth, 0.05, 1),
      } satisfies MiniRect,
    });
  };

  const isLive = liveMode && Boolean(liveRoom);
  const displayTitle = isLive ? liveRoom?.title ?? '直播' : info?.title ?? 'B站视频皮肤';

  const qualityLabel =
    info?.qualities.find((quality) => quality.qn === info.quality)?.desc ??
    (info ? `${info.quality}P` : '');

  const qualityItems = (() => {
    const items = info?.qualities?.length
      ? [...info.qualities]
      : QUALITY_CHOICES.map((qn) => ({ qn, desc: `qn ${qn}` }));
    const current = info?.quality ?? settings.quality;
    if (!items.some((item) => item.qn === current)) {
      items.unshift({ qn: current, desc: `qn ${current}` });
    }
    return items;
  })();

  const episodeLabel =
    info && (info.episodes?.length ?? 0) > 1 ? `第 ${info.episodeIndex + 1}/${info.episodes.length} 集` : '';

  const videoLayer = (
    <div id="bili-skin-video-layer" style={layerStyle}>
      {srcUrl ? (
        <video
          ref={videoRef}
          className="bili-video"
          style={videoBox ?? undefined}
          src={srcUrl}
          muted={muted || Boolean(audioSrc)}
          playsInline
          preload="auto"
          onLoadedMetadata={(event) => {
            applyMediaSettings();
            updateVideoRatio(event.currentTarget);
            setDuration(event.currentTarget.duration || 0);
            syncAudio();
          }}
          onLoadedData={(event) => {
            // 点播不自动播放时，暂停着的 <video> 有时不出首帧（看起来就是“没画面”）。
            // 轻微 seek 一下强制解码并绘制第一帧；每换一次源只做一次。
            const video = event.currentTarget;
            if (frameNudged.current || hasPlayedRef.current || !video.paused) {
              return;
            }
            if (video.currentTime > 0.05 || video.readyState < 2) {
              return;
            }
            frameNudged.current = true;
            try {
              video.currentTime = 0.04;
            } catch {
              // 还没到可 seek 状态就忽略
            }
          }}
          onResize={(event) => updateVideoRatio(event.currentTarget)}
          onTimeUpdate={(event) => {
            const time = event.currentTarget.currentTime;
            setCurrentTime(time);
            if (settings.danmaku) {
              emitDanmaku(time);
            }
            if (!event.currentTarget.paused) {
              syncAudio();
            }
          }}
          onPlay={() => {
            startedRef.current = true;
            toast.dismiss('bili-ready');
            applyMediaSettings();
            setPlaying(true);
            syncAudio();
          }}
          onPlaying={() => {
            hasPlayedRef.current = true;
            bufferingRef.current = false;
            setBuffering(false);
            syncAudio();
          }}
          onPause={(event) => {
            setPlaying(false);
            setAudioBlocked(false);
            // 卡顿导致的 pause 由 handleWaiting 负责，不要把 buffering 清掉。
            if (!bufferingRef.current) {
              setBuffering(false);
            }
            const audio = audioRef.current;
            if (audio) {
              audio.pause();
              try {
                audio.currentTime = event.currentTarget.currentTime;
              } catch {
                // audio 尚未可 seek
              }
            }
          }}
          onSeeking={() => audioRef.current?.pause()}
          onSeeked={() => {
            tryResume();
            syncAudio();
          }}
          onWaiting={handleWaiting}
          onStalled={handleWaiting}
          onProgress={() => tryResume()}
          onCanPlay={() => tryResume()}
          onEnded={() => {
            bufferingRef.current = false;
            setBuffering(false);
            audioRef.current?.pause();
          }}
          onError={handleVideoError}
        />
      ) : null}
      {audioSrc ? (
        <audio
          key={audioSrc}
          ref={audioRef}
          src={audioSrc}
          muted={muted}
          preload="auto"
          aria-hidden="true"
          style={{
            position: 'absolute',
            width: 1,
            height: 1,
            opacity: 0,
            pointerEvents: 'none',
          }}
          onLoadedMetadata={() => syncAudio()}
          onPlaying={() => {
            setAudioReady(true);
            syncAudio();
          }}
          onCanPlay={() => {
            setAudioReady(true);
            syncAudio();
          }}
          onError={(event) => {
            if (event.currentTarget === audioRef.current) {
              setAudioReady(true);
              handleAudioError();
            }
          }}
        />
      ) : null}
      <div className="bili-dim" />
      {buffering && srcUrl && videoBox && revealVideo ? (
        <div className="bili-buffer" style={videoBox}>
          <span className="bili-buffer-ring">
            <span className="bili-spinner" />
          </span>
        </div>
      ) : null}
    </div>
  );

  if (!state) {
    return null;
  }

  return (
    <>
      {createPortal(videoLayer, videoHost)}
      <div
        className="bili-hud"
        ref={hudRootRef}
        style={{ display: visible ? undefined : 'none' }}
      >
        <div className="bili-dock">
          <div
            className="bili-panel"
            ref={panelRef}
            data-inactive={!open}
            aria-hidden={!open}
            inert={!open}
          >
            <div className="bili-panel-content" ref={panelContentRef}>
              <div className="bp-flex bp-items-center bp-gap-2 bili-divider-b bp-px-3 bp-py-2.5">
                {info || isLive ? (
                  <img
                    className="bp-h-6 bp-w-6 bp-shrink-0 bp-rounded-md bp-object-cover"
                    src={logoUrl}
                    alt=""
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <span className="bili-skeleton bili-skeleton-avatar" />
                )}
                <div className="bp-min-w-0 bp-flex-1">
                  {isLive ? (
                    <>
                      <div className="bp-truncate bp-text-[13px] bp-font-medium">{displayTitle}</div>
                      <div className="bp-truncate bp-text-[11px] bili-muted">
                        {`直播${liveRoom?.currentQn ? ` · ${liveQualityLabel(liveRoom.currentQn)}` : ''}${
                          liveRoom?.owner ? ` · ${liveRoom.owner}` : ''
                        }${liveRoom?.online ? ` · ${liveRoom.online} 人气` : ''}`}
                      </div>
                    </>
                  ) : info ? (
                    <>
                      <div className="bp-truncate bp-text-[13px] bp-font-medium">{info.title}</div>
                      <div className="bp-truncate bp-text-[11px] bili-muted">
                        {`${info.owner} · ${qualityLabel}${episodeLabel ? ` · ${episodeLabel}` : ''}${
                          audioPreparing ? ' · 正在同步音频…' : ` · ${formatTime(currentTime)} / ${formatTime(duration)}`
                        }`}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="bili-skeleton bili-skeleton-line" style={{ width: '72%' }} />
                      <div
                        className="bili-skeleton bili-skeleton-line bili-skeleton-line-sm"
                        style={{ width: '52%' }}
                      />
                    </>
                  )}
                </div>
                <button
                  type="button"
                  className="bili-icon-btn"
                  title="收起"
                  aria-label="收起控制条"
                  onClick={collapsePanel}
                >
                  <Minus width={15} height={15} />
                </button>
              </div>

            <div className="bp-space-y-2.5 bp-px-3 bp-py-3">
              <div className="bp-flex bp-items-center bp-gap-2.5">
                <button
                  type="button"
                  className="bili-play-btn"
                  aria-label={busy ? '加载中' : playing ? '暂停' : '播放'}
                  aria-busy={busy}
                  onClick={togglePlay}
                >
                  {busy ? (
                    <span className="bili-spinner" />
                  ) : playing ? (
                    <PlayerPause width={16} height={16} />
                  ) : (
                    <PlayerPlay width={16} height={16} />
                  )}
                </button>
                <div className="bp-flex bp-min-w-0 bp-flex-1 bp-items-center bp-gap-2">
                  {isLive ? (
                    <>
                      <span className="bili-live-badge">LIVE</span>
                      <span className="bp-text-[11px] bili-muted">
                        {liveLoading ? '正在连接直播流…' : '直播没有进度条，暂停后继续会回到最新画面'}
                      </span>
                    </>
                  ) : (
                    <>
                      <Slider
                        className="bp-flex-1"
                        min={0}
                        max={Math.max(duration, 0.1)}
                        step={0.1}
                        value={[Math.min(currentTime, duration || 0.1)]}
                        onValueChange={([next]) => {
                          setCurrentTime(next);
                          if (videoRef.current) {
                            videoRef.current.currentTime = next;
                          }
                        }}
                        aria-label="播放进度"
                      />
                      {info ? (
                        <span className="bp-w-[86px] bp-shrink-0 bp-text-right bp-text-[11px] bp-tabular-nums bili-muted">
                          {formatTime(currentTime)} / {formatTime(duration)}
                        </span>
                      ) : (
                        <span className="bili-skeleton bili-skeleton-time" />
                      )}
                    </>
                  )}
                </div>
              </div>

              <div className="bp-flex bp-items-center bp-gap-2">
                <button
                  type="button"
                  className={`bili-icon-btn ${muted ? 'bili-muted' : ''}`}
                  title={muted ? '取消静音' : '静音'}
                  aria-label={muted ? '取消静音' : '静音'}
                  onClick={toggleMute}
                >
                  <Volume width={15} height={15} />
                </button>
                <Slider
                  className="bili-volume-slider"
                  min={0}
                  max={1}
                  step={0.01}
                  value={[muted ? 0 : volume]}
                  onValueChange={([next]) => changeVolume(next)}
                  aria-label="音量"
                />
                <div className="bp-ml-auto bp-flex bp-items-center bp-gap-1.5">
                  {!info && !isLive ? (
                    <>
                      <span className="bili-skeleton bili-skeleton-chip" />
                      <span className="bili-skeleton bili-skeleton-chip" />
                    </>
                  ) : (
                    <>
                  <button
                    type="button"
                    className="bili-icon-btn"
                    title={settings.danmaku ? '关闭弹幕输出' : '把弹幕按时间打印到输出面板'}
                    aria-label="弹幕"
                    aria-pressed={settings.danmaku}
                    onClick={toggleDanmaku}
                  >
                    <MessageDots width={13} height={13} />
                  </button>
                  {settings.fit === 'mini' ? (
                    <button
                      type="button"
                      className="bili-icon-btn"
                      title="小屏设置"
                      aria-label="小屏设置"
                      aria-pressed={miniEditing}
                      onClick={toggleMiniEditing}
                    >
                      <PictureInPicture width={13} height={13} />
                    </button>
                  ) : null}
                  {isLive ? (
                    <button
                      type="button"
                      className="bili-icon-btn"
                      title="刷新直播"
                      aria-label="刷新直播"
                      onClick={() =>
                        void loadLiveInput(
                          input || String(liveRoom?.roomId ?? ''),
                          liveRoom?.currentQn,
                        )
                      }
                    >
                      <Refresh width={13} height={13} />
                    </button>
                  ) : null}
                  {isLive ? (
                    <Select
                      value={String(liveRoom?.currentQn ?? 10000)}
                      onValueChange={(value) =>
                        void loadLiveInput(
                          input || String(liveRoom?.roomId ?? ''),
                          Number(value),
                        )
                      }
                    >
                      <SelectTrigger
                        className="bili-select-trigger bili-quality-trigger"
                        aria-label="直播清晰度"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(liveRoom?.acceptQn?.length
                          ? liveRoom.acceptQn
                          : [liveRoom?.currentQn ?? 10000]
                        ).map((qn) => (
                          <SelectItem key={qn} value={String(qn)}>
                            {liveQualityLabel(qn)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                  {isLive ? null : (
                    <>
                      <button
                        type="button"
                        className="bili-icon-btn"
                        title="刷新清晰度（登录后可用更高画质）"
                        aria-label="刷新清晰度"
                        onClick={refreshPlayInfo}
                      >
                        <Refresh width={13} height={13} />
                      </button>
                      <Select
                        value={String(info?.quality ?? settings.quality)}
                        onValueChange={(value) => void changeQuality(Number(value))}
                      >
                        <SelectTrigger
                          className="bili-select-trigger bili-quality-trigger"
                          aria-label="清晰度"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {qualityItems.map((quality) => (
                            <SelectItem key={quality.qn} value={String(quality.qn)}>
                              {quality.desc}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </>
                  )}
                  <Select
                    value={settings.fit}
                    onValueChange={(value) => {
                      const fit = value as SkinSettings['fit'];
                      if (fit === 'mini' && settings.fit !== 'mini') {
                        openMiniEditing();
                      }
                      updateSettings({ fit });
                    }}
                  >
                    <SelectTrigger className="bili-select-trigger bili-fit-trigger" aria-label="显示方式">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="full">完整</SelectItem>
                      <SelectItem value="mini">小屏</SelectItem>
                    </SelectContent>
                  </Select>
                    </>
                  )}
                </div>
              </div>

              {miniEditing ? (
                <div
                  className="bili-mini-editor bili-body-swap-anim"
                  style={{ height: miniBodyHeight ?? 260 }}
                >
                  {!miniActiveRect ? (
                    <div className="bp-flex bp-items-center bili-divider-t bp-pt-2.5">
                      <span className="bili-skeleton bili-skeleton-line" style={{ width: '60%' }} />
                    </div>
                  ) : (
                    <>
                      <div className="bp-flex bp-items-center bp-gap-2 bili-divider-t bp-pt-2.5">
                        <span className="bp-text-[12px]">小屏位置</span>
                        <span className="bp-text-[10px] bili-muted">拖动移动 · 左下角缩放</span>
                        <Button
                          variant="link"
                          size="sm"
                          className="bili-link-btn bp-ml-auto"
                          onClick={() => updateSettings({ miniRect: DEFAULT_SKIN_SETTINGS.miniRect })}
                        >
                          重置
                        </Button>
                      </div>
                      <div className="bili-mini-preview" ref={miniPreviewRef}>
                      {miniPreviewScale > 0 ? (
                        <div
                          className="bili-mini-stage"
                          style={{
                            width: Math.round(miniStageWidth * miniPreviewScale),
                            height: Math.round(miniStageHeight * miniPreviewScale),
                          }}
                        >
                          <div
                            className="bili-mini-canvas"
                            style={{
                              width: miniStageWidth,
                              height: miniStageHeight,
                              transform: `scale(${miniPreviewScale})`,
                            }}
                          >
                            <div
                              className="bili-mini-forbidden bili-mini-forbidden-top"
                              style={{ height: contentTop }}
                            />
                            <div
                              className="bili-mini-forbidden bili-mini-forbidden-side"
                              style={{ width: minimapWidth }}
                            />
                            <div
                              className="bili-mini-thumb bili-mini-thumb-icon"
                              style={{
                                left: miniActiveRect.x,
                                top: miniActiveRect.y,
                                width: miniActiveRect.w,
                                height: miniActiveRect.h,
                              }}
                              aria-hidden="true"
                            >
                              <LiveTvFilled
                                width={Math.min(
                                  28 / (miniPreviewScale || 1),
                                  miniActiveRect.w * 0.5,
                                  miniActiveRect.h * 0.5,
                                )}
                                height={Math.min(
                                  28 / (miniPreviewScale || 1),
                                  miniActiveRect.w * 0.5,
                                  miniActiveRect.h * 0.5,
                                )}
                              />
                            </div>
                            <div
                              ref={miniBoxRef}
                              className="bili-mini-box"
                              style={{
                                borderWidth: 2 / (miniPreviewScale || 1),
                                left: miniActiveRect.x,
                                top: miniActiveRect.y,
                                width: miniActiveRect.w,
                                height: miniActiveRect.h,
                              }}
                              onPointerDown={startMiniGesture('move')}
                              onPointerMove={moveMiniGesture}
                              onPointerUp={finishMiniGesture}
                              onPointerCancel={finishMiniGesture}
                            >
                              <span
                                className="bili-mini-box-handle"
                                style={{
                                  width: 18 / (miniPreviewScale || 1),
                                  height: 18 / (miniPreviewScale || 1),
                                  left: -9 / (miniPreviewScale || 1),
                                  bottom: -9 / (miniPreviewScale || 1),
                                  borderWidth: 2 / (miniPreviewScale || 1),
                                }}
                                onPointerDown={startMiniGesture('resize')}
                              />
                            </div>
                          </div>
                        </div>
                      ) : null}
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div
                  className={`bp-space-y-2.5${miniBodyHeight !== null ? ' bili-body-swap-anim' : ''}`}
                  ref={normalBodyRef}
                >
              {isLive ? null : !info ? (
                <div className="bp-flex bp-items-center bili-divider-t bp-pt-2">
                  <span className="bili-skeleton bili-skeleton-episode" />
                </div>
              ) : info.episodes && info.episodes.length > 1 ? (
                <div className="bp-flex bp-items-center bp-gap-1.5 bili-divider-t bp-pt-2">
                  <button
                    type="button"
                    className="bili-icon-btn"
                    title="上一集"
                    aria-label="上一集"
                    disabled={info.episodeIndex <= 0}
                    onClick={() => void switchEpisode(info.episodeIndex - 1)}
                  >
                    <ChevronLeft width={15} height={15} />
                  </button>
                  <Select
                    value={String(info.episodeIndex)}
                    onValueChange={(value) => void switchEpisode(Number(value))}
                  >
                    <SelectTrigger className="bili-select-trigger bili-episode-trigger" aria-label="选择剧集">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(info.episodes ?? []).map((episode, index) => (
                        <SelectItem key={`${episode.bvid}:${episode.page}:${index}`} value={String(index)}>
                          {`第 ${index + 1} 集 · ${episode.title}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <button
                    type="button"
                    className="bili-icon-btn"
                    title="下一集"
                    aria-label="下一集"
                    disabled={info.episodeIndex >= (info.episodes?.length ?? 0) - 1}
                    onClick={() => void switchEpisode(info.episodeIndex + 1)}
                  >
                    <ChevronRight width={15} height={15} />
                  </button>
                </div>
              ) : null}

              <SliderRow
                label="透明度"
                value={settings.opacity}
                min={0.05}
                max={1}
                step={0.01}
                display={`${Math.round(settings.opacity * 100)}%`}
                onChange={(value) => updateSettings({ opacity: value })}
              />
              <SliderRow
                label="模糊"
                value={settings.blur}
                min={0}
                max={40}
                step={1}
                display={`${Math.round(settings.blur)}px`}
                onChange={(value) => updateSettings({ blur: value })}
              />
              <SliderRow
                label="暗化"
                value={settings.dim}
                min={0}
                max={1}
                step={0.01}
                display={`${Math.round(settings.dim * 100)}%`}
                onChange={(value) => updateSettings({ dim: value })}
              />

              <div className="bp-flex bp-items-center bp-justify-between bp-gap-3 bili-divider-t bp-pt-2.5">
                <div className="bp-min-w-0">
                  <div className="bp-text-[12px]">移除黑边</div>
                  <div className="bp-text-[10px] bili-muted">
                    探测画面真实比例后裁掉片源黑边（首次检测约 1-2 秒）
                  </div>
                </div>
                <Switch
                  checked={settings.cropBars}
                  onCheckedChange={(checked) => updateSettings({ cropBars: checked })}
                  aria-label="移除黑边"
                />
              </div>

              <div className="bp-flex bp-items-center bp-justify-between bp-gap-3">
                <div className="bp-min-w-0">
                  <div className="bp-text-[12px]">隐藏播放模式</div>
                  <div className="bp-text-[10px] bili-muted">
                    鼠标悬停控制条时才显示视频，移开暗化 100%
                  </div>
                </div>
                <Switch
                  checked={settings.hiddenMode}
                  onCheckedChange={(checked) => updateSettings({ hiddenMode: checked })}
                  aria-label="隐藏播放模式"
                />
              </div>

              <div className="bp-flex bp-gap-2">
                <input
                  className="bili-input"
                  type="text"
                  placeholder={liveMode ? '直播间链接或房间号，如 live.bilibili.com/6' : 'BV1GJ411x7h7 或视频链接'}
                  value={input}
                  spellCheck={false}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      void loadManual();
                    }
                  }}
                />
                <Button onClick={() => void loadManual()} disabled={loading || liveLoading}>
                  {loading || liveLoading ? '加载中' : '播放'}
                </Button>
              </div>
                </div>
              )}

              <div className="bp-flex bp-items-center bp-gap-2 bili-divider-t bp-pt-2">
                <div className="bp-flex bp-items-center bp-gap-2">
                  <Switch
                    checked={liveMode}
                    onCheckedChange={changeLiveMode}
                    aria-label="直播模式"
                  />
                  <span className="bp-text-[11px] bili-subtle">直播模式</span>
                </div>
                <div className="bp-ml-auto bp-flex bp-items-center bp-gap-2">
                  {!state ? (
                    <>
                      <span className="bili-skeleton bili-skeleton-avatar-sm" />
                      <span className="bili-skeleton bili-skeleton-name" />
                    </>
                  ) : state.user ? (
                    <>
                      <img
                        className="bp-h-5 bp-w-5 bp-rounded-full bp-object-cover"
                        src={state.user.face}
                        alt=""
                        referrerPolicy="no-referrer"
                      />
                      <span className="bp-max-w-[96px] bp-truncate bp-text-[11px] bili-text">
                        {state.user.name}
                      </span>
                      {state.user.vip ? <span className="bili-vip">大会员</span> : null}
                      <Button
                        variant="link"
                        size="sm"
                        className="bili-link-btn"
                        onClick={() => void logout()}
                      >
                        退出
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="bili-login-btn"
                      onClick={() => setLoginOpen(true)}
                    >
                      <UserCircle width={13} height={13} />
                      扫码登录
                    </Button>
                  )}
                </div>
              </div>
            </div>
            </div>
          </div>
          <div
            className="bili-pill"
            ref={pillRef}
            data-inactive={open}
            data-mini={!open && !pillWide}
            data-collapsing={pillCollapsing}
            data-expanding={pillExpanding}
            aria-hidden={open}
            inert={open}
          >
            <div className="bili-pill-content" ref={pillContentRef}>
              <button
                type="button"
                className="bili-play-btn bili-play-btn-small bili-pill-play"
                aria-label={
                  pillCollapsing ? '收起中' : buffering ? '缓冲中' : busy ? '加载中' : playing ? '暂停' : '播放'
                }
                aria-busy={busy || buffering}
                onClick={pillCollapsing || buffering ? undefined : togglePlay}
              >
                {busy || buffering ? (
                  <span className="bili-spinner" />
                ) : pillCollapsing ? (
                  <MoreHorizTwotone width={16} height={16} />
                ) : playing ? (
                  <PlayerPause width={13} height={13} />
                ) : (
                  <PlayerPlay width={13} height={13} />
                )}
              </button>
              {canHoverVolume ? (
                <TooltipProvider delayDuration={120}>
                  <Tooltip>
                    <TooltipTrigger asChild>{volumeTrigger}</TooltipTrigger>
                    <TooltipContent side="top" className="bili-vol-tooltip">
                      <Slider
                        orientation="vertical"
                        min={0}
                        max={1}
                        step={0.01}
                        value={[muted ? 0 : volume]}
                        onValueChange={([next]) => changeVolume(next)}
                        aria-label="音量"
                      />
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : (
                volumeTrigger
              )}
              {audioPreparing ? (
                <span className="bili-sync-chip" title="正在把音轨转成可播放的格式">
                  <span className="bili-spinner bili-spinner-xs" />
                  同步音频
                </span>
              ) : null}
              <span
                ref={pillTitleWrapRef}
                className="bili-pill-title bp-min-w-0 bp-flex-1 bp-text-[12px] bili-text"
                onMouseEnter={startTitleScroll}
                onMouseLeave={stopTitleScroll}
              >
                <span ref={pillTitleRef} className="bili-pill-title-inner">
                  {displayTitle}
                </span>
              </span>
              <button
                type="button"
                className="bili-icon-btn"
                title="展开控制条"
                aria-label="展开控制条"
                onClick={expandPanel}
              >
                <Settings width={14} height={14} />
              </button>
              {isLive ? (
                <button
                  type="button"
                  className="bili-icon-btn"
                  title="刷新直播"
                  aria-label="刷新直播"
                  onClick={() =>
                    void loadLiveInput(input || String(liveRoom?.roomId ?? ''), liveRoom?.currentQn)
                  }
                >
                  <Refresh width={14} height={14} />
                </button>
              ) : null}
              <button
                type="button"
                className="bili-icon-btn"
                title={settings.danmaku ? '关闭弹幕输出' : '把弹幕按时间打印到输出面板'}
                aria-label="弹幕"
                aria-pressed={settings.danmaku}
                onClick={() => {
                  // 从迷你展开后鼠标正好落在右侧按钮上，避免误触
                  if (Date.now() - pillExpandedAt.current < 400) {
                    return;
                  }
                  toggleDanmaku();
                }}
              >
                <MessageDots width={14} height={14} />
              </button>
              <button
                type="button"
                className="bili-icon-btn bili-collapse-btn"
                title="收起到迷你胶囊"
                aria-label="收起到迷你胶囊"
                onClick={collapsePill}
              >
                <ChevronRight20Filled width={14} height={14} />
              </button>
              <button
                type="button"
                className="bili-play-btn bili-play-btn-small bili-mini-btn"
                title={busy ? '加载中' : '展开控制条'}
                aria-label={busy ? '加载中' : '展开控制条'}
                aria-busy={busy}
                onClick={() => {
                  pillExpandedAt.current = Date.now();
                  window.clearTimeout(pillCollapseTimer.current);
                  setPillCollapsing(false);
                  setPillWide(true);
                  setPillExpanding(true);
                  window.clearTimeout(pillExpandTimer.current);
                  pillExpandTimer.current = window.setTimeout(() => setPillExpanding(false), 800);
                }}
              >
                {busy || buffering ? (
                  <span className="bili-spinner" />
                ) : (
                  <MoreHorizTwotone width={16} height={16} />
                )}
              </button>
            </div>
          </div>
        </div>

        {loginOpen ? (
          <div
            ref={modalOverlayRef}
            className="bili-modal-overlay"
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                closeLogin();
              }
            }}
          >
            <div ref={modalRef} className="bili-modal">
              <div className="bp-mb-3 bp-flex bp-items-center bp-justify-between">
                <span className="bp-flex bp-items-center bp-gap-1.5 bp-text-[13px] bp-font-medium">
                  <Qrcode width={15} height={15} />
                  扫码登录 B 站
                </span>
                <button type="button" className="bili-icon-btn" aria-label="关闭登录框" onClick={closeLogin}>
                  <X width={14} height={14} />
                </button>
              </div>

              <div className="bili-qr-center">
                {qr ? (
                  <img className="bili-qr-image" src={qr.image} alt="B站登录二维码" />
                ) : (
                  <div className="bili-qr-placeholder">
                    {loginLoading ? '生成中…' : '二维码不可用'}
                  </div>
                )}
              </div>

              <p className="bp-mt-3 bp-text-center bp-text-[11px] bili-muted">
                {loginMessage || '打开哔哩哔哩 App → 我的 → 扫一扫'}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="bp-mt-3 bp-w-full"
                onClick={() => void refreshQr()}
              >
                <Refresh width={13} height={13} />
                刷新二维码
              </Button>
            </div>
          </div>
        ) : null}

        <Toaster
          position="top-right"
          offset={18}
          theme={isLightTheme ? 'light' : 'dark'}
          toastOptions={{
            style: {
              background: 'var(--bili-bg)',
              color: 'var(--bili-fg)',
              border: '1px solid var(--bili-border)',
              borderRadius: '10px',
              fontFamily: 'var(--bili-font)',
              fontSize: '12px',
            },
          }}
          style={
            {
              '--normal-bg': 'var(--bili-bg)',
              '--normal-text': 'var(--bili-fg)',
              '--normal-border': 'var(--bili-border)',
            } as CSSProperties
          }
        />
      </div>
    </>
  );
}

interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (value: number) => void;
}

function SliderRow({ label, value, min, max, step, display, onChange }: SliderRowProps) {
  return (
    <div className="bp-flex bp-items-center bp-gap-2.5">
      <span className="bp-w-[44px] bp-shrink-0 bp-text-[11px] bili-muted">{label}</span>
      <Slider
        className="bp-flex-1"
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([next]) => onChange(next)}
        aria-label={label}
      />
      <span className="bp-w-[38px] bp-shrink-0 bp-text-right bp-text-[11px] bp-tabular-nums bili-subtle">
        {display}
      </span>
    </div>
  );
}

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return '00:00';
  }
  const total = Math.floor(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorName(error: unknown): string {
  if (error instanceof DOMException) {
    return error.name;
  }
  if (typeof error === 'object' && error !== null && 'name' in error) {
    return String((error as { name?: unknown }).name);
  }
  return '';
}

/** play() 被 pause()/切源打断属于正常流程，不能当成播放失败弹给用户。 */
function isAbortError(error: unknown): boolean {
  return errorName(error) === 'AbortError';
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)?.slice(0, 1200) ?? String(value);
  } catch {
    return String(value);
  }
}
