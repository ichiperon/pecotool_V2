// Worker 境界のメッセージ型（discriminated union）。
// thumbnail.worker.ts / useThumbnailPanel.ts / ThumbnailWindow.tsx で共有。

export type ThumbnailWorkerRequest =
  | { type: 'LOAD_PDF'; url: string; bytes?: undefined }
  | { type: 'LOAD_PDF'; bytes: ArrayBuffer; url?: undefined }
  | { type: 'GENERATE_THUMBNAIL'; pageIndex: number };

export type ThumbnailWorkerResponse =
  | { type: 'LOAD_COMPLETE'; numPages: number }
  | { type: 'LOAD_ERROR'; message: string }
  | { type: 'THUMBNAIL_DONE'; pageIndex: number; bytes: Uint8Array }
  | { type: 'THUMBNAIL_ERROR'; pageIndex: number; error?: string };

export type RasterizeRequest = {
  type: 'RASTERIZE_PDF';
  data: {
    originalPdfBytes: Uint8Array;
    documentState: unknown;
    quality: number;
    fontBytes?: ArrayBuffer;
  };
};

export type RasterizeResponse =
  | { type: 'RASTERIZE_PROGRESS'; current: number; total: number }
  | { type: 'RASTERIZE_SUCCESS'; data: Uint8Array }
  | { type: 'ERROR'; message: string };
