import type { ClaudexApi } from '../shared/types';

declare global {
  interface Window {
    claudex: ClaudexApi;
  }
}

export {};
