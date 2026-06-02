/// <reference types="vite/client" />

declare module 'pdfjs-dist/build/pdf.worker.min.mjs' {
  const url: string;
  export default url;
}
declare module 'pdfjs-dist/build/pdf.worker.min.mjs?url' {
  const url: string;
  export default url;
}

// issue #43: tauri.conf.json の version をビルド時に埋め込み (vite.config.ts の define)
declare const __APP_VERSION__: string;

// Feature #202: @tauri-apps/plugin-updater stub
// The actual package is installed at runtime; this stub satisfies tsc until
// `npm install` is run with the version pinned in package.json.
declare module '@tauri-apps/plugin-updater' {
  export interface Update {
    available: boolean;
    version: string;
    body: string | null;
    downloadAndInstall(
      onProgress?: (progress: { chunkLength: number; contentLength: number | null }) => void
    ): Promise<void>;
  }
  export function check(): Promise<Update | null>;
}
