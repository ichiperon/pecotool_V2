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
