import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
/// <reference types="vitest" />

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// tauri.conf.json をビルド時に読み込んでアプリバージョンを埋め込む (issue #43)。
// HelpModal の「バージョン情報」表示で `__APP_VERSION__` 経由で参照する。
const tauriConf = JSON.parse(readFileSync("./src-tauri/tauri.conf.json", "utf-8"));
const appVersion: string = tauriConf.version ?? "0.0.0";

// https://vite.dev/config/
export default defineConfig(async ({ command }) => ({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/__tests__/{unit,components,integration}/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**', '**/src/__tests__/e2e/**'],
    // vitest 4.1.2 + Windows の既定 pool 'forks' には "Cannot read properties of undefined (reading 'config')"
    // が発生する既知の問題 (getRunner() 未初期化) があるため、安定する vmThreads を明示指定する。
    pool: 'vmThreads',
    // Feature #202: @tauri-apps/plugin-updater は npm install 前は node_modules に存在しない。
    // Vite の import-analysis transform が解決できず test スイートが落ちるため、
    // テスト環境ではスタブファイルに alias で向ける。
    alias: {
      '@tauri-apps/plugin-updater': new URL('./src/__tests__/__stubs__/tauri-plugin-updater.ts', import.meta.url).pathname,
    },
  },

  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // pdfjs-dist を別チャンクに分離（初回ロードを軽量化）
          'pdfjs': ['pdfjs-dist'],
          // pdf-lib は保存時のみ使用するため分離
          'pdf-lib': ['@cantoo/pdf-lib'],
          // react-virtuoso は OCR エディタとサムネイルウィンドウで使用
          'virtuoso': ['react-virtuoso'],
        },
      },
    },
  },

  // Resolve alias for modules unavailable in plain browser context (dev server / E2E).
  // @tauri-apps/plugin-updater is only available inside a real Tauri runtime.
  // Without this alias the vite import-analysis plugin throws an error that prevents
  // the dev server from serving the app — which breaks all Playwright E2E tests.
  //
  // #328 (PCT-105): この alias は **dev server (command === 'serve') 限定**で張る。
  // 旧実装は無条件 alias だったため本番ビルド (command === 'build') でも
  // plugin-updater が stub (check = async () => null) に解決され、自動更新チェックが
  // 常に「最新です」を返して機能していなかった。build 時は alias を張らず、
  // node_modules の実プラグインをバンドルして実 Tauri IPC に到達させる。
  resolve: {
    alias:
      command === 'serve'
        ? {
            '@tauri-apps/plugin-updater': new URL(
              './src/__tests__/__stubs__/tauri-plugin-updater.e2e.ts',
              import.meta.url,
            ).pathname,
          }
        : {},
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
