import type { AtlasApi } from '../shared/ipc-contract'

declare global {
  interface Window {
    atlas: AtlasApi
  }
}

export {}
