import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
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

interface HudProps {
  config: SkinConfig;
  videoHost: HTMLElement;
}

const QUALITY_CHOICES = [16, 32, 64, 74, 80, 112, 116, 120];

export function Hud({ config, videoHost }: HudProps) {
  const api = useMemo(() => new SkinApi(config), [config]);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [state, setState] = useState<SkinState | null>(null);
  const [settings, setSettings] = useState<SkinSettings>(DEFAULT_SKIN_SETTINGS);
  const [info, setInfo] = useState<PlayInfo | null>(null);
  const [srcUrl, setSrcUrl] = useState<string | null>(null);
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

  const requestedKey = useRef('');
  const backupIndex = useRef(0);
  const pendingSeek = useRef(0);
  const initialized = useRef(false);
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
    async (ref: VideoRef, qn: number) => {
      setLoading(true);
      setError(null);
      try {
        const next = await api.play(ref, qn);
        setInfo(next);
        setSrcUrl(next.url);
        backupIndex.current = 0;
        setDuration(next.duration || 0);
      } catch (loadError) {
        setError(toMessage(loadError));
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

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
    }
  }, [visible]);

  // 有些用户之前用脚本注入过后台视频（#bilibili-background-video），它和本皮肤同为
  // z-index:-1 且更晚插入 DOM，会盖住我们的视频。显示皮肤时临时隐藏它。
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

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !srcUrl) {
      return;
    }

    video.muted = mutedRef.current;
    video.volume = volumeRef.current;
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
  }, [srcUrl]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = muted;
    }
  }, [muted]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
    }
  }, [volume]);

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

  const loadManual = async () => {
    const ref = parseVideoInput(input);
    if (!ref) {
      setError('无法识别 BV 号 / av 号 / 链接');
      return;
    }

    requestedKey.current = `${ref.bvid ?? `av${ref.aid ?? ''}`}:${ref.page ?? 1}`;
    await load(ref, settings.quality);
    try {
      await api.patch({ video: { bvid: ref.bvid, aid: ref.aid, page: ref.page }, visible: true });
    } catch {
      setOnline(false);
    }
  };

  const changeQuality = async (qn: number) => {
    const ref = stateRef.current?.video;
    if (!ref) {
      return;
    }
    pendingSeek.current = videoRef.current?.currentTime ?? 0;
    updateSettings({ quality: qn });
    await load(ref, qn);
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (video.paused) {
      void video.play().catch(() => undefined);
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
    '--bili-opacity': settings.opacity,
    '--bili-blur': `${settings.blur}px`,
    '--bili-dim': settings.dim,
    '--bili-fit': settings.fit,
  } as CSSProperties;

  const qualityLabel =
    info?.qualities.find((quality) => quality.qn === info.quality)?.desc ??
    (info ? `${info.quality}P` : '');

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
          onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onError={handleVideoError}
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
      <div className="bili-hud">
        {open ? (
          <div className="bili-panel">
            <div className="bp-flex bp-items-center bp-gap-2 bp-border-b bp-border-white/10 bp-px-3 bp-py-2.5">
              <span className="bp-flex bp-h-6 bp-w-6 bp-shrink-0 bp-items-center bp-justify-center bp-rounded-md bp-bg-[#fb7299] bp-text-[13px] bp-font-bold bp-text-black">
                B
              </span>
              <div className="bp-min-w-0 bp-flex-1">
                <div className="bp-truncate bp-text-[13px] bp-font-medium">
                  {info?.title ?? '未加载视频'}
                </div>
                <div className="bp-truncate bp-text-[11px] bp-text-zinc-400">
                  {info
                    ? `${info.owner} · ${qualityLabel} · ${formatTime(currentTime)} / ${formatTime(duration)}`
                    : '输入 BV 号或链接，把视频铺到代码下面'}
                </div>
              </div>
              <button
                type="button"
                className="bili-icon-btn"
                title="收起"
                aria-label="收起控制条"
                onClick={() => setOpen(false)}
              >
                —
              </button>
              <button
                type="button"
                className="bili-icon-btn"
                title="隐藏皮肤（Cmd/Ctrl+Alt+B 恢复）"
                aria-label="隐藏皮肤"
                onClick={() => void hideSkin()}
              >
                ×
              </button>
            </div>

            <div className="bp-space-y-2.5 bp-px-3 bp-py-3">
              <div className="bp-flex bp-items-center bp-gap-2.5">
                <button
                  type="button"
                  className="bp-flex bp-h-9 bp-w-9 bp-shrink-0 bp-items-center bp-justify-center bp-rounded-full bp-bg-[#fb7299] bp-text-[13px] bp-text-black hover:bp-bg-[#ff8aae]"
                  aria-label={playing ? '暂停' : '播放'}
                  onClick={togglePlay}
                >
                  {playing ? '❚❚' : '▶'}
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
                  <span className="bp-w-[86px] bp-shrink-0 bp-text-right bp-text-[11px] bp-tabular-nums bp-text-zinc-400">
                    {formatTime(currentTime)} / {formatTime(duration)}
                  </span>
                </div>
              </div>

              <div className="bp-flex bp-items-center bp-gap-2">
                <button
                  type="button"
                  className="bili-icon-btn"
                  title={muted ? '取消静音' : '静音'}
                  aria-label={muted ? '取消静音' : '静音'}
                  onClick={() => {
                    const next = !muted;
                    setMuted(next);
                    updateSettings({ muted: next });
                  }}
                >
                  {muted ? '🔇' : '🔊'}
                </button>
                <input
                  className="bili-range bp-w-[74px]"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={muted ? 0 : volume}
                  aria-label="音量"
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setVolume(next);
                    setMuted(next === 0);
                  }}
                />
                <select
                  className="bili-select bp-ml-auto"
                  value={String(info?.quality ?? settings.quality)}
                  title="清晰度"
                  aria-label="清晰度"
                  onChange={(event) => void changeQuality(Number(event.target.value))}
                >
                  {(info?.qualities?.length
                    ? info.qualities
                    : QUALITY_CHOICES.map((qn) => ({ qn, desc: `qn ${qn}` }))
                  ).map((quality) => (
                    <option key={quality.qn} value={quality.qn}>
                      {quality.desc}
                    </option>
                  ))}
                </select>
                <select
                  className="bili-select"
                  value={settings.fit}
                  title="铺满方式"
                  aria-label="铺满方式"
                  onChange={(event) => updateSettings({ fit: event.target.value as SkinSettings['fit'] })}
                >
                  <option value="cover">铺满</option>
                  <option value="contain">完整</option>
                  <option value="fill">拉伸</option>
                </select>
              </div>

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
                max={0.8}
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
                <button type="button" className="bili-primary-btn" onClick={() => void loadManual()}>
                  {loading ? '加载中' : '播放'}
                </button>
              </div>

              {error ? (
                <div className="bp-flex bp-items-start bp-gap-2 bp-rounded-lg bp-bg-red-500/10 bp-px-2 bp-py-1.5 bp-text-[11px] bp-text-red-300">
                  <span className="bp-flex-1">{error}</span>
                  <button type="button" className="bp-text-red-200 bp-underline" onClick={retry}>
                    重试
                  </button>
                </div>
              ) : null}

              <div className="bp-flex bp-items-center bp-gap-2 bp-border-t bp-border-white/10 bp-pt-2">
                <span
                  className={`bp-h-1.5 bp-w-1.5 bp-rounded-full ${
                    online ? 'bp-bg-emerald-400' : 'bp-bg-red-400'
                  }`}
                />
                <span className="bp-text-[11px] bp-text-zinc-500">
                  {online ? '本地服务已连接' : '本地服务断开'}
                </span>

                <div className="bp-ml-auto bp-flex bp-items-center bp-gap-2">
                  {state?.user ? (
                    <>
                      <img
                        className="bp-h-5 bp-w-5 bp-rounded-full bp-object-cover"
                        src={state.user.face}
                        alt=""
                                    />
                      <span className="bp-max-w-[96px] bp-truncate bp-text-[11px] bp-text-zinc-300">
                        {state.user.name}
                      </span>
                      {state.user.vip ? (
                        <span className="bp-rounded bp-bg-[#fb7299]/20 bp-px-1 bp-py-0.5 bp-text-[10px] bp-text-[#fb7299]">
                          大会员
                        </span>
                      ) : null}
                      <button type="button" className="bili-link-btn" onClick={() => void logout()}>
                        退出
                      </button>
                    </>
                  ) : (
                    <button type="button" className="bili-link-btn" onClick={() => setLoginOpen(true)}>
                      扫码登录
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="bili-pill">
            <button
              type="button"
              className="bp-flex bp-h-7 bp-w-7 bp-items-center bp-justify-center bp-rounded-full bp-bg-[#fb7299] bp-text-[11px] bp-text-black"
              aria-label={playing ? '暂停' : '播放'}
              onClick={togglePlay}
            >
              {playing ? '❚❚' : '▶'}
            </button>
            <span className="bp-max-w-[180px] bp-truncate bp-text-[12px] bp-text-zinc-200">
              {info?.title ?? 'B站视频皮肤'}
            </span>
            <button
              type="button"
              className="bili-icon-btn"
              title="展开控制条"
              aria-label="展开控制条"
              onClick={() => setOpen(true)}
            >
              ⚙
            </button>
            <button
              type="button"
              className="bili-icon-btn"
              title="隐藏皮肤"
              aria-label="隐藏皮肤"
              onClick={() => void hideSkin()}
            >
              ×
            </button>
          </div>
        )}

        {loginOpen ? (
          <div className="bp-fixed bp-inset-0 bp-z-10 bp-flex bp-pointer-events-auto bp-items-center bp-justify-center bp-bg-black/60">
            <div className="bp-w-[320px] bp-rounded-2xl bp-border bp-border-white/10 bp-bg-[#101014] bp-p-4 bp-text-zinc-100 bp-shadow-2xl">
              <div className="bp-mb-3 bp-flex bp-items-center bp-justify-between">
                <span className="bp-text-[13px] bp-font-medium">扫码登录 B 站</span>
                <button
                  type="button"
                  className="bili-icon-btn"
                  aria-label="关闭登录框"
                  onClick={() => {
                    setLoginOpen(false);
                    setQr(null);
                  }}
                >
                  ×
                </button>
              </div>

              {qr ? (
                <img
                  className="bp-mx-auto bp-h-[220px] bp-w-[220px] bp-rounded-lg bp-bg-white bp-p-2"
                  src={qr.image}
                  alt="B站登录二维码"
                />
              ) : (
                <div className="bp-mx-auto bp-flex bp-h-[220px] bp-w-[220px] bp-items-center bp-justify-center bp-rounded-lg bp-bg-white/5 bp-text-[12px] bp-text-zinc-400">
                  {loginLoading ? '生成中…' : '二维码不可用'}
                </div>
              )}

              <p className="bp-mt-3 bp-text-center bp-text-[11px] bp-text-zinc-400">
                {loginMessage || '打开哔哩哔哩 App → 我的 → 扫一扫'}
              </p>
              <button
                type="button"
                className="bp-mt-3 bp-w-full bp-rounded-lg bp-border bp-border-white/10 bp-bg-transparent bp-py-1.5 bp-text-[12px] bp-text-zinc-300 hover:bp-bg-white/5"
                onClick={() => void refreshQr()}
              >
                刷新二维码
              </button>
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
      <span className="bp-w-[44px] bp-shrink-0 bp-text-[11px] bp-text-zinc-400">{label}</span>
      <input
        className="bili-range bp-flex-1"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="bp-w-[38px] bp-shrink-0 bp-text-right bp-text-[11px] bp-tabular-nums bp-text-zinc-500">
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
