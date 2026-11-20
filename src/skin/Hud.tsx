import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import {
  ChevronLeft,
  ChevronRight,
  Minus,
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
import { MoreHorizTwotone } from '@ricons/material';
import { Toaster, toast } from 'sonner';
import { parseVideoInput } from '../bilibili/parse';
import type {
  LoginQr,
  PlayInfo,
  SkinConfig,
  SkinSettings,
  SkinState,
  VideoRef,
} from '../shared/types';
import { DEFAULT_SKIN_SETTINGS } from '../shared/types';
import { SkinApi } from './api';
import { Button } from './components/ui/button';
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
  const [notice, setNotice] = useState<string | null>(null);
  const [audioReady, setAudioReady] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [online, setOnline] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [hudHovered, setHudHovered] = useState(false);
  const [pillWide, setPillWide] = useState(false);
  const [pillExpanding, setPillExpanding] = useState(false);
  const [titleTruncated, setTitleTruncated] = useState(false);
  const pillExpandedAt = useRef(0);
  const pillExpandTimer = useRef<number | undefined>(undefined);
  const titleRef = useRef<HTMLSpanElement | null>(null);
  const [input, setInput] = useState('');
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(DEFAULT_SKIN_SETTINGS.muted);
  const [volume, setVolume] = useState(0.8);
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
    const name =
      error instanceof DOMException
        ? error.name
        : typeof error === 'object' && error !== null && 'name' in error
          ? String((error as { name?: unknown }).name)
          : '';
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
  const testContextRef = useRef<AudioContext | null>(null);
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
      setOnline(true);
      return next;
    } catch {
      setOnline(false);
      return undefined;
    }
  }, [api]);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;

    const tick = async () => {
      if (disposed) {
        return;
      }
      await refreshState();
      if (!disposed) {
        timer = window.setTimeout(tick, 2000);
      }
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
    if (!ref) {
      return;
    }
    pendingSeek.current = videoRef.current?.currentTime ?? 0;
    void load(ref, settingsRef.current.quality);
  }, [load]);

  const videoKey = state?.video
    ? `${state.video.bvid ?? `av${state.video.aid ?? ''}`}:${state.video.page ?? 1}`
    : '';

  useEffect(() => {
    const ref = state?.video;
    if (!ref || !videoKey || requestedKey.current === videoKey) {
      return;
    }
    requestedKey.current = videoKey;
    setInput(ref.bvid ?? `av${ref.aid ?? ''}`);
    void load(ref, settingsRef.current.quality);
  }, [videoKey, state, load]);

  const visible = state ? state.visible : true;
  visibleRef.current = visible;

  useEffect(() => {
    document.body.classList.toggle('bili-skin-on', visible);
    return () => document.body.classList.remove('bili-skin-on');
  }, [visible]);

  useEffect(() => {
    if (!visible) {
      videoRef.current?.pause();
      audioRef.current?.pause();
    }
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
      setPillExpanding(false);
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

    if (settingsRef.current.autoplay && visibleRef.current) {
      void video.play()?.catch((error) => {
        // VS Code/Chromium 可能阻止带声音的自动播放；提醒用户点一下。
        if (settingsRef.current.muted === false) {
          notePlayError(error);
        }
      });
    }

    return () => video.removeEventListener('loadedmetadata', onMetadata);
  }, [srcUrl, applyMediaSettings, notePlayError]);

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

  // 标题被截断时才挂原生 title，避免没截断也弹 tooltip。
  useEffect(() => {
    const element = titleRef.current;
    if (!element) {
      return;
    }
    const check = () => {
      setTitleTruncated(element.scrollWidth > element.clientWidth + 1);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [info?.title, pillWide, pillExpanding, open]);

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
      void testContextRef.current?.close().catch(() => undefined);
      testContextRef.current = null;
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
    const events = [
      'loadstart',
      'loadedmetadata',
      'loadeddata',
      'canplay',
      'canplaythrough',
      'playing',
      'pause',
      'waiting',
      'stalled',
      'suspend',
      'error',
      'emptied',
    ];
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
        void api.patch({ settings: payload }).catch(() => setOnline(false));
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

  const loadManual = async () => {
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
        setOnline(false);
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
        setOnline(false);
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
      void video
        .play()
        .then(() => setAudioBlocked(false))
        .catch((error) => {
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

  const playTestTone = () => {
    // 1) Web Audio：不经过 CSP/网络，直接验证 workbench 有没有音频输出。
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) {
        throw new Error('AudioContext 不可用');
      }
      const context = testContextRef.current ?? new Ctor();
      testContextRef.current = context;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = 440;
      gain.gain.value = Math.max(0.05, Math.min(0.5, volumeRef.current));
      oscillator.connect(gain);
      gain.connect(context.destination);
      const startAt = context.currentTime + 0.02;
      oscillator.start(startAt);
      oscillator.stop(startAt + 1);
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
      };
      void context
        .resume()
        .then(() => {
          logClient('info', 'test tone (web audio)', {
            state: context.state,
            sampleRate: context.sampleRate,
            volume: volumeRef.current,
          });
          setNotice(`测试音已播放（Web Audio：${context.state}）`);
        })
        .catch((error: unknown) => {
          logClient('error', 'test tone web audio failed', {
            message: toMessage(error),
            state: context.state,
          });
          setError(`测试音失败：${toMessage(error)}`);
        });
    } catch (error) {
      logClient('error', 'test tone setup failed', { message: toMessage(error) });
      setError(`测试音失败：${toMessage(error)}`);
    }

    // 2) 探测 workbench 对常见音频编码的支持（音量极低，不干扰）。
    const canPlay = document.createElement('audio');
    const support = [
      'audio/mpeg',
      'audio/wav',
      'audio/mp4; codecs="mp4a.40.2"',
      'audio/webm; codecs="opus"',
    ].map((type) => [type, canPlay.canPlayType(type)]);
    let mediaSource: boolean | null = null;
    try {
      mediaSource =
        typeof MediaSource !== 'undefined'
          ? MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"')
          : null;
    } catch {
      mediaSource = null;
    }
    logClient('info', 'media codec support', { support, mediaSource });

    for (const extension of ['mp3', 'wav'] as const) {
      const probe = new Audio(api.testToneUrl(extension));
      probe.volume = 0.001;
      probe
        .play()
        .then(() => {
          logClient('info', `test tone (${extension} over http)`, {
            readyState: probe.readyState,
            duration: probe.duration,
            audioBytes: (probe as HTMLAudioElement & { webkitAudioDecodedByteCount?: number })
              .webkitAudioDecodedByteCount,
          });
          probe.pause();
        })
        .catch((error: unknown) => {
          logClient('error', `test tone ${extension} failed`, {
            name: error instanceof DOMException ? error.name : undefined,
            message: toMessage(error),
          });
        });
    }
  };

  const hideSkin = async () => {
    try {
      await api.patch({ visible: false });
      setState((previous) => (previous ? { ...previous, visible: false } : previous));
    } catch {
      setOnline(false);
    }
  };

  const handleVideoError = () => {
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
  const busy = loading || audioPreparing;
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
      toast.loading('正在准备音轨…', { id: 'bili-audio', duration: Infinity });
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
    '--bili-fit': settings.fit,
  } as CSSProperties;

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
          src={srcUrl}
          muted={muted || Boolean(audioSrc)}
          playsInline
          preload="auto"
          onLoadedMetadata={(event) => {
            applyMediaSettings();
            setDuration(event.currentTarget.duration || 0);
            syncAudio();
          }}
          onTimeUpdate={(event) => {
            setCurrentTime(event.currentTarget.currentTime);
            if (!event.currentTarget.paused) {
              syncAudio();
            }
          }}
          onPlay={() => {
            applyMediaSettings();
            setPlaying(true);
            syncAudio();
          }}
          onPlaying={() => syncAudio()}
          onPause={(event) => {
            setPlaying(false);
            setAudioBlocked(false);
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
          onSeeked={() => syncAudio()}
          onWaiting={() => audioRef.current?.pause()}
          onEnded={() => audioRef.current?.pause()}
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
    </div>
  );

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
                {info ? (
                  <img
                    className="bp-h-6 bp-w-6 bp-shrink-0 bp-rounded-md bp-object-cover"
                    src={logoUrl}
                    alt=""
                  />
                ) : (
                  <span className="bili-skeleton bili-skeleton-avatar" />
                )}
                <div className="bp-min-w-0 bp-flex-1">
                  {info ? (
                    <>
                      <div className="bp-truncate bp-text-[13px] bp-font-medium">{info.title}</div>
                      <div className="bp-truncate bp-text-[11px] bili-muted">
                        {`${info.owner} · ${qualityLabel}${episodeLabel ? ` · ${episodeLabel}` : ''} · ${formatTime(currentTime)} / ${formatTime(duration)}`}
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
                <button
                  type="button"
                  className="bili-icon-btn"
                  title="隐藏皮肤（Cmd/Ctrl+Alt+B 恢复）"
                  aria-label="隐藏皮肤"
                  onClick={() => void hideSkin()}
                >
                  <X width={15} height={15} />
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
                  <input
                    className="bili-range"
                    type="range"
                    min={0}
                    max={Math.max(duration, 0.1)}
                    step={0.1}
                    value={Math.min(currentTime, duration || 0.1)}
                    style={rangeFill(currentTime, 0, Math.max(duration, 0.1))}
                    aria-label="播放进度"
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      setCurrentTime(next);
                      if (videoRef.current) {
                        videoRef.current.currentTime = next;
                      }
                    }}
                  />
                  {info ? (
                    <span className="bp-w-[86px] bp-shrink-0 bp-text-right bp-text-[11px] bp-tabular-nums bili-muted">
                      {formatTime(currentTime)} / {formatTime(duration)}
                    </span>
                  ) : (
                    <span className="bili-skeleton bili-skeleton-time" />
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
                <input
                  className="bili-range bili-volume-range"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={muted ? 0 : volume}
                  style={rangeFill(muted ? 0 : volume, 0, 1)}
                  aria-label="音量"
                  onChange={(event) => changeVolume(Number(event.target.value))}
                />
                <div className="bp-ml-auto bp-flex bp-items-center bp-gap-1.5">
                  {!info ? (
                    <>
                      <span className="bili-skeleton bili-skeleton-chip" />
                      <span className="bili-skeleton bili-skeleton-chip" />
                    </>
                  ) : (
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
                    <SelectTrigger className="bili-select-trigger bili-quality-trigger" aria-label="清晰度">
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
                  <Select
                    value={settings.fit}
                    onValueChange={(value) => updateSettings({ fit: value as SkinSettings['fit'] })}
                  >
                    <SelectTrigger className="bili-select-trigger bili-fit-trigger" aria-label="铺满方式">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cover">铺满</SelectItem>
                      <SelectItem value="contain">完整</SelectItem>
                      <SelectItem value="fill">拉伸</SelectItem>
                    </SelectContent>
                  </Select>
                    </>
                  )}
                </div>
              </div>

              {!info ? (
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
                  placeholder="BV1GJ411x7h7 或视频链接"
                  value={input}
                  spellCheck={false}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      void loadManual();
                    }
                  }}
                />
                <Button onClick={() => void loadManual()} disabled={loading}>
                  {loading ? '加载中' : '播放'}
                </Button>
              </div>

              <div className="bp-flex bp-items-center bp-gap-2 bili-divider-t bp-pt-2">
                <span className={`bili-dot ${online ? 'bili-dot-online' : 'bili-dot-offline'}`} />
                <span className="bp-text-[11px] bili-subtle">
                  {online ? '本地服务已连接' : '本地服务断开'}
                </span>
                <Button variant="link" size="sm" className="bili-link-btn" onClick={playTestTone}>
                  测试声音
                </Button>

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
            data-expanding={pillExpanding}
            aria-hidden={open}
            inert={open}
          >
            <div className="bili-pill-content" ref={pillContentRef}>
              <button
                type="button"
                className="bili-play-btn bili-play-btn-small bili-pill-play"
                aria-label={busy ? '加载中' : playing ? '暂停' : '播放'}
                aria-busy={busy}
                onClick={togglePlay}
              >
                {busy ? (
                  <span className="bili-spinner" />
                ) : playing ? (
                  <PlayerPause width={13} height={13} />
                ) : (
                  <PlayerPlay width={13} height={13} />
                )}
              </button>
              <button
                type="button"
                className={`bili-icon-btn ${muted ? 'bili-muted' : ''}`}
                title={muted ? '取消静音' : '静音'}
                aria-label={muted ? '取消静音' : '静音'}
                onClick={toggleMute}
              >
                <Volume width={14} height={14} />
              </button>
              <input
                className="bili-range bili-pill-volume"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                style={rangeFill(muted ? 0 : volume, 0, 1)}
                aria-label="音量"
                onChange={(event) => changeVolume(Number(event.target.value))}
              />
              <span
                ref={titleRef}
                title={titleTruncated ? (info?.title ?? 'B站视频皮肤') : undefined}
                className="bp-min-w-0 bp-flex-1 bp-truncate bp-text-[12px] bili-text"
              >
                {info?.title ?? 'B站视频皮肤'}
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
              <button
                type="button"
                className="bili-icon-btn"
                title="隐藏皮肤"
                aria-label="隐藏皮肤"
                onClick={() => {
                  // 从迷你展开后，鼠标位置正好落在右侧的 X 上，避免误触
                  if (Date.now() - pillExpandedAt.current < 400) {
                    return;
                  }
                  void hideSkin();
                }}
              >
                <X width={14} height={14} />
              </button>
              <button
                type="button"
                className="bili-icon-btn"
                title="收起到迷你胶囊"
                aria-label="收起到迷你胶囊"
                onClick={() => {
                  window.clearTimeout(pillExpandTimer.current);
                  setPillExpanding(false);
                  setPillWide(false);
                }}
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
                  setPillWide(true);
                  setPillExpanding(true);
                  window.clearTimeout(pillExpandTimer.current);
                  pillExpandTimer.current = window.setTimeout(() => setPillExpanding(false), 800);
                }}
              >
                {busy ? <span className="bili-spinner" /> : <MoreHorizTwotone width={16} height={16} />}
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
    <label className="bp-flex bp-items-center bp-gap-2.5">
      <span className="bp-w-[44px] bp-shrink-0 bp-text-[11px] bili-muted">{label}</span>
      <input
        className="bili-range bp-flex-1"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={rangeFill(value, min, max)}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="bp-w-[38px] bp-shrink-0 bp-text-right bp-text-[11px] bp-tabular-nums bili-subtle">
        {display}
      </span>
    </label>
  );
}

function rangeFill(value: number, min: number, max: number): CSSProperties {
  const ratio = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
  return { '--bili-range-fill': `${ratio * 100}%` } as CSSProperties;
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

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)?.slice(0, 1200) ?? String(value);
  } catch {
    return String(value);
  }
}
