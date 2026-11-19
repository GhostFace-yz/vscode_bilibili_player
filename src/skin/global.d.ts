import type { SkinConfig } from '../shared/types';

declare global {
  interface Window {
    __BILI_SKIN_CONFIG__?: SkinConfig;
    __BILI_SKIN_MOUNTED__?: boolean;
  }
}

export {};
