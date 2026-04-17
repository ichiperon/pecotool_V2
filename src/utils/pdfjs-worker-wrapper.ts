// pdfjs Worker ラッパー
// Tauri asset protocol は Range Request (206) を返すが Accept-Ranges ヘッダーを含めない。
// pdfjs は Accept-Ranges: bytes がないと Range 非対応と判定し、全データダウンロードする。
// Worker 内の fetch をパッチして Accept-Ranges: bytes を注入してから pdfjs Worker を読み込む。

const _origFetch = self.fetch.bind(self);
self.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  if (url && url.includes('asset.localhost')) {
    return _origFetch(input, init).then((response: Response) => {
      const headers = new Headers(response.headers);
      if (!headers.has('accept-ranges')) {
        headers.set('accept-ranges', 'bytes');
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    });
  }
  return _origFetch(input, init);
} as typeof fetch;

// fetch パッチ適用後にオリジナルの pdfjs Worker コードを動的に読み込む
// (static import は巻き上げられてパッチ前に実行されるため dynamic import を使用)
import('pdfjs-dist/build/pdf.worker.min.mjs');
