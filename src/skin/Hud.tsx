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
  const [online, setOnline] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
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

  const stateRef = useRef<SkinState | null>(state);
  stateRef.current = state;
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
      video.muted = mutedRef.current;
      video.volume = volumeRef.current;
    }
    if (audio) {
      audio.muted = mutedRef.current;
      audio.volume = volumeRef.current;
    }
  }, []);

  const requestedKey = useRef('');
  const backupIndex = useRef(0);
  const pendingSeek = useRef(0);
  const initialized = useRef(false);
  const lastAuthRevision = useRef<number | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const pendingSave = useRef<Partial<SkinSettings>>({});

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
      setLoading(true);
      setError(null);
      setNotice(null);
      try {
        const next = await api.play(ref, qn);
        setInfo(next);
        setSrcUrl(next.url);
        setAudioSrc(next.audioUrl ?? null);
        backupIndex.current = 0;
        setDuration(next.duration || 0);
        return next;
      } catch (loadError) {
        setError(toMessage(loadError));
        return null;
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

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

  // 旧版 douyinhelper/bilibilihelper 注入的 #bilibili-background-video 会盖住我们的视频。
  useEffect(() => {
    if (!visible) {
      return;
    }

    let previousDisplay: string | null = null;
    const hideLegacy = (): boolean => {
      const legacy = document.getElementById('bilibili-background-video');
      if (!legacy) {
        return false;
      }
      if (previousDisplay === null) {
        previousDisplay = legacy.style.display;
      }
      legacy.style.display = 'none';
      return true;
    };

    hideLegacy();
    const timer = window.setInterval(() => {
      if (hideLegacy()) {
        window.clearInterval(timer);
      }
    }, 500);
    const stop = window.setTimeout(() => window.clearInterval(timer), 10_000);

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

    if (settingsRef.current.autoplay) {
      void video.play()?.catch(() => undefined);
    }

    return () => video.removeEventListener('loadedmetadata', onMetadata);
  }, [srcUrl, applyMediaSettings]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = muted;
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

  // DASH 是独立音轨：让 audio 跟随 video 的播放/暂停/进度，并做轻量漂移修正
  const syncAudio = useCallback(function sync(force = false) {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video || !audio || !audio.getAttribute('src')) {
      return;
    }
    applyMediaSettings();
    if (audio.readyState < 1) {
      audio.addEventListener('loadedmetadata', () => sync(true), { once: true });
      return;
    }
    if (force || Math.abs(audio.currentTime - video.currentTime) > 0.35) {
      try {
        audio.currentTime = video.currentTime;
      } catch {
        // 音频尚未可 seek
      }
    }
    if (video.paused) {
      audio.pause();
    } else {
      void audio.play().catch(() => undefined);
    }
  }, [applyMediaSettings]);

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
      setEditorBounds((previous) => {
        if (
          previous &&
          Math.abs(previous.left - rect.left) < 0.5 &&
          Math.abs(previous.top - rect.top) < 0.5 &&
          Math.abs(previous.width - rect.width) < 0.5 &&
          Math.abs(previous.height - rect.height) < 0.5
        ) {
          return previous;
        }
        return {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          right: rect.right,
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
    // offsetWidth/offsetHeight 不受当前 transform 影响，快速连续点击也不会算错目标比例。
    const fromWidth = panel.offsetWidth;
    const fromHeight = panel.offsetHeight;
    const toWidth = pill.offsetWidth;
    const toHeight = pill.offsetHeight;
    if (fromWidth < 1 || fromHeight < 1 || toWidth < 1 || toHeight < 1) {
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
      timeline.to(content, { filter: 'blur(9px)', opacity: 0.6, duration: 0.12, ease: 'power1.out' }, 0);
      timeline.to(content, { opacity: 0, duration: 0.18, ease: 'power1.in' }, 0.16);
    }
    timeline.to(
      panel,
      {
        scaleX: toWidth / fromWidth,
        scaleY: toHeight / fromHeight,
        transformOrigin: '100% 100%',
        duration: 0.3,
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

    if (open && pendingExpandFrom.current) {
      const from = pendingExpandFrom.current;
      pendingExpandFrom.current = null;
      morphRef.current?.kill();
      // 上一次收起可能留下了缩放 transform，先清掉才能量到完整尺寸。
      gsap.set(panel, { clearProps: 'transform,transformOrigin' });
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      if (width < 1 || height < 1) {
        return;
      }

      const content = panelContentRef.current;
      gsap.set(panel, {
        transformOrigin: '100% 100%',
        scaleX: from.width / width,
        scaleY: from.height / height,
      });
      if (content) {
        gsap.set(content, { filter: 'blur(12px)', opacity: 0.5 });
      }

      const timeline = gsap.timeline({
        onComplete: () => {
          gsap.set(panel, { clearProps: 'transform,transformOrigin' });
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
      timeline.to(panel, { scaleX: 1, scaleY: 1, duration: 0.44, ease: 'power3.out' }, 0);
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
      void video.play().catch((error) => setError(`播放失败：${toMessage(error)}`));
    } else {
      video.pause();
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

  const layerStyle = {
    left: editorBounds ? `${editorBounds.left}px` : '0px',
    top: editorBounds ? `${editorBounds.top}px` : '0px',
    width: editorBounds ? `${editorBounds.width}px` : '0px',
    height: editorBounds ? `${editorBounds.height}px` : '0px',
    visibility: editorBounds ? 'visible' : 'hidden',
    '--bili-opacity': settings.opacity,
    '--bili-blur': `${settings.blur}px`,
    '--bili-dim': settings.dim,
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
          muted={muted}
          playsInline
          preload="auto"
          onLoadedMetadata={(event) => {
            applyMediaSettings();
            setDuration(event.currentTarget.duration || 0);
            syncAudio(true);
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
            syncAudio(true);
          }}
          onPause={() => {
            setPlaying(false);
            audioRef.current?.pause();
          }}
          onSeeking={() => syncAudio(true)}
          onEnded={() => audioRef.current?.pause()}
          onError={handleVideoError}
        />
      ) : null}
      {audioSrc ? (
        <audio
          ref={audioRef}
          src={audioSrc}
          muted={muted}
          preload="auto"
          style={{ display: 'none' }}
          onLoadedMetadata={() => syncAudio(true)}
          onCanPlay={() => syncAudio(true)}
          onError={() => undefined}
        />
      ) : null}
      <div className="bili-dim" />
    </div>
  );

  if (!visible) {
    return null;
  }

  return (
    <>
      {createPortal(videoLayer, videoHost)}
      <div className="bili-hud" ref={hudRootRef}>
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
                <img
                  className="bp-h-6 bp-w-6 bp-shrink-0 bp-rounded-md bp-object-cover"
                  src={logoUrl}
                  alt=""
                />
                <div className="bp-min-w-0 bp-flex-1">
                  <div className="bp-truncate bp-text-[13px] bp-font-medium">
                    {info?.title ?? '未加载视频'}
                  </div>
                  <div className="bp-truncate bp-text-[11px] bili-muted">
                    {info
                      ? `${info.owner} · ${qualityLabel}${episodeLabel ? ` · ${episodeLabel}` : ''} · ${formatTime(currentTime)} / ${formatTime(duration)}`
                      : '输入 BV 号或链接，把视频铺到代码下面'}
                  </div>
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
                  aria-label={playing ? '暂停' : '播放'}
                  onClick={togglePlay}
                >
                  {playing ? <PlayerPause width={16} height={16} /> : <PlayerPlay width={16} height={16} />}
                </button>
                <div className="bp-flex bp-min-w-0 bp-flex-1 bp-items-center bp-gap-2">
                  <input
                    className="bili-range"
                    type="range"
                    min={0}
                    max={Math.max(duration, 0.1)}
                    step={0.1}
                    value={Math.min(currentTime, duration || 0.1)}
                    aria-label="播放进度"
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      setCurrentTime(next);
                      if (videoRef.current) {
                        videoRef.current.currentTime = next;
                      }
                    }}
                  />
                  <span className="bp-w-[86px] bp-shrink-0 bp-text-right bp-text-[11px] bp-tabular-nums bili-muted">
                    {formatTime(currentTime)} / {formatTime(duration)}
                  </span>
                </div>
              </div>

              <div className="bp-flex bp-items-center bp-gap-2">
                <button
                  type="button"
                  className={`bili-icon-btn ${muted ? 'bili-muted' : ''}`}
                  title={muted ? '取消静音' : '静音'}
                  aria-label={muted ? '取消静音' : '静音'}
                  onClick={() => {
                    const next = !muted;
                    if (!next && volumeRef.current === 0) {
                      setVolume(0.8);
                      volumeRef.current = 0.8;
                    }
                    setMuted(next);
                    updateSettings({ muted: next });
                    if (videoRef.current) {
                      videoRef.current.muted = next;
                      videoRef.current.volume = volumeRef.current;
                    }
                    if (audioRef.current) {
                      audioRef.current.muted = next;
                      audioRef.current.volume = volumeRef.current;
                    }
                  }}
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
                  aria-label="音量"
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    const nextMuted = next === 0;
                    setVolume(next);
                    volumeRef.current = next;
                    setMuted(nextMuted);
                    updateSettings({ muted: nextMuted });
                    if (videoRef.current) {
                      videoRef.current.volume = next;
                      videoRef.current.muted = nextMuted;
                    }
                    if (audioRef.current) {
                      audioRef.current.volume = next;
                      audioRef.current.muted = nextMuted;
                    }
                  }}
                />
                <div className="bp-ml-auto bp-flex bp-items-center bp-gap-1.5">
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
                </div>
              </div>

              {info && (info.episodes?.length ?? 0) > 1 ? (
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

              {error ? (
                <div className="bili-alert bili-alert-error">
                  <span className="bp-flex-1">{error}</span>
                  <Button variant="secondary" size="sm" className="bp-shrink-0" onClick={retry}>
                    重试
                  </Button>
                </div>
              ) : null}

              {notice ? <div className="bili-alert bili-alert-warning">{notice}</div> : null}

              <div className="bp-flex bp-items-center bp-gap-2 bili-divider-t bp-pt-2">
                <span className={`bili-dot ${online ? 'bili-dot-online' : 'bili-dot-offline'}`} />
                <span className="bp-text-[11px] bili-subtle">
                  {online ? '本地服务已连接' : '本地服务断开'}
                </span>

                <div className="bp-ml-auto bp-flex bp-items-center bp-gap-2">
                  {state?.user ? (
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
            aria-hidden={open}
            inert={open}
          >
            <div className="bili-pill-content" ref={pillContentRef}>
              <button
                type="button"
                className="bili-play-btn bili-play-btn-small"
                aria-label={playing ? '暂停' : '播放'}
                onClick={togglePlay}
              >
                {playing ? <PlayerPause width={13} height={13} /> : <PlayerPlay width={13} height={13} />}
              </button>
              <span className="bp-max-w-[200px] bp-truncate bp-text-[12px] bili-text">
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
                onClick={() => void hideSkin()}
              >
                <X width={14} height={14} />
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
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="bp-w-[38px] bp-shrink-0 bp-text-right bp-text-[11px] bp-tabular-nums bili-subtle">
        {display}
      </span>
    </label>
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
