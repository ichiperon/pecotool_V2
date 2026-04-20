import React, { Suspense, useEffect } from "react";
import ReactDOM from "react-dom/client";
import { prewarmPdfjsWorker } from "./utils/pdfLoader";

// PDF.js Worker を React レンダー前に起動（初回ファイル読込の高速化）
prewarmPdfjsWorker();

// pdf-lib chunk を idle 時間に先読みし、保存時の初動を速くする
// (vite.config の manualChunks で別 chunk 化されているため、dynamic import で
//  バンドルキャッシュに載せておくと、後続の pdfSaver からの読み込みが即時解決される)
if (typeof requestIdleCallback === 'function') {
  requestIdleCallback(() => {
    import('@cantoo/pdf-lib').catch(() => {});
  }, { timeout: 5000 });
} else {
  setTimeout(() => { import('@cantoo/pdf-lib').catch(() => {}); }, 2000);
}

const hash = window.location.hash;

const LazyApp = React.lazy(() => import("./App"));
const LazyTextPreviewWindow = React.lazy(() => import("./components/TextPreviewWindow").then(m => ({ default: m.TextPreviewWindow })));
const LazyThumbnailWindow = React.lazy(() => import("./components/ThumbnailWindow/ThumbnailWindow").then(m => ({ default: m.ThumbnailWindow })));

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch() {
    document.getElementById('splashscreen')?.remove();
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, color: '#e2e8f0', background: '#1e293b', height: '100vh' }}>
          <h2>読み込みに失敗しました</h2>
          <p>{this.state.error.message}</p>
          <button onClick={() => location.reload()} style={{ marginTop: 16, padding: '8px 16px', cursor: 'pointer' }}>
            再読み込み
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function DismissSplash({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const splash = document.getElementById('splashscreen');
    if (splash) {
      splash.classList.add('fade-out');
      setTimeout(() => splash.remove(), 300);
    }
  }, []);
  return <>{children}</>;
}

const root: React.ReactNode = hash === '#preview'
  ? <LazyTextPreviewWindow />
  : hash === '#thumbnails'
  ? <LazyThumbnailWindow />
  : <LazyApp />;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Suspense fallback={null}>
        <DismissSplash>
          {root}
        </DismissSplash>
      </Suspense>
    </ErrorBoundary>
  </React.StrictMode>,
);
