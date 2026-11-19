import { createRoot } from 'react-dom/client';
import { Hud } from './Hud';

function boot(): void {
  const config = window.__BILI_SKIN_CONFIG__;
  if (!config) {
    console.warn('[bilibili-skin] missing window.__BILI_SKIN_CONFIG__');
    return;
  }
  if (window.__BILI_SKIN_MOUNTED__) {
    return;
  }
  window.__BILI_SKIN_MOUNTED__ = true;

  const videoHost = document.createElement('div');
  videoHost.id = 'bili-skin-video-host';
  const hudHost = document.createElement('div');
  hudHost.id = 'bili-skin-hud';

  document.body.append(videoHost, hudHost);
  createRoot(hudHost).render(<Hud config={config} videoHost={videoHost} />);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
