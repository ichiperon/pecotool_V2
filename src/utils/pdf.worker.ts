import type {
  SavePdfWorkerRequest,
  SavePdfWorkerResponse,
  SerializedPageData,
  SkippedPdfTextChar,
} from './pdfWorkerTypes';
import type { SaveDialogOptions } from '../hooks/useFileOperations';
import {
  buildPdfDocumentCore,
} from './pdfSaverCore';

async function handleSavePdf(
  originalPdfBytes: Uint8Array,
  documentState: { pages: Record<number, SerializedPageData>; totalPages?: number },
  fontBytes: ArrayBuffer | undefined,
  fallbackFontBytes: ArrayBuffer[] = [],
  pageOrder?: number[],
  options?: SaveDialogOptions,
  // M-1 (bug-hunt): SAVE_PDF_HEARTBEAT は従来 setInterval(1000ms) のみで送信していたが、
  // このあと呼ぶ buildPdfDocumentCore 内部（pako/fontkit/pdf-lib）の同期 CPU バウンド区間
  // では worker 自身のイベントループが塞がり、setInterval のコールバックは区間が終わるまで
  // 発火できない。5秒を超える同期区間があると、main 殻（別スレッド）が heartbeat 無応答と
  // 誤判定して健全な worker を terminate しうる。
  // 対策として onProgress を core のページ処理ループ粒度に配線し、呼び出し元 (self.onmessage)
  // からそこで直接 self.postMessage する関数を注入する。postMessage はスレッドを跨ぐ通知の
  // ため、worker 側の同期実行が続いていても main スレッド（自分のイベントループを持つ別
  // スレッド）は即座に受信できる。setInterval の heartbeat はそのまま残し、非同期待機区間
  // （fetch 等）向けの保険として併用する。
  //
  // 依存注入にしているのは、この関数を直接叩く既存テスト (__handleSavePdfForTest) が jsdom
  // 環境で走るため。jsdom の `self` は Window の別名で、`postMessage` は Worker と異なり
  // 第2引数 (targetOrigin) 必須で呼ぶと TypeError になる。onProgress 未指定（テスト既定）
  // なら core 側は何も呼ばない no-op のため、既存テストの挙動には影響しない。
  onProgress?: () => void,
): Promise<{ savedBytes: Uint8Array; skippedChars: SkippedPdfTextChar[]; bytePreserved: boolean }> {
  // D1: Record<number, SerializedPageData> → Map<number, SerializedPageData> に正規化。
  const pagesMap = new Map<number, SerializedPageData>();
  for (const [key, value] of Object.entries(documentState.pages)) {
    pagesMap.set(Number(key), value);
  }

  // D4: worker 殻は saveTimeoutMs:90_000 を渡す。
  // PCT-114: main 殻 (pdfSaver.ts) は常に documentState.totalPages を渡す。worker 殻は
  // シリアライズ境界を跨ぐため totalPages が欠落する経路（一部の直接呼び出し/テスト契約）
  // が存在しうる。その場合のみ pagesMap.size にフォールバックする。本番 SAVE_PDF 経路では
  // 常に totalPages が供給されるためフォールバックには到達しない（main と等価）。
  return buildPdfDocumentCore(
    originalPdfBytes,
    { totalPages: documentState.totalPages ?? pagesMap.size, pages: pagesMap },
    fontBytes,
    fallbackFontBytes,
    { options, pageOrder, saveTimeoutMs: 90_000, onProgress },
  );
}

export const __handleSavePdfForTest = handleSavePdf;

// Worker scope での self 型付け。WebWorker lib を tsconfig で有効化しているため DedicatedWorkerGlobalScope が使える。
declare const self: DedicatedWorkerGlobalScope;

// PCT-194 (#425): main 殻 (pdfSaver.ts) の PREVIOUS_SAVE_TIMEOUT_MS は、旧実装では
// 「前回保存タスクが完了したか」のみを見ていたため、5秒を超える正常な保存中に
// 2回目の保存が実行されると進行中の worker を誤って terminate していた。
// SAVE_PDF 処理中はこの周期で軽量 heartbeat を postMessage し、main 殻側で
// 「進捗ベースの生存判定」（直近 heartbeat から一定時間無応答なら stale とみなす）
// を行えるようにする。PREVIOUS_SAVE_TIMEOUT_MS(5000ms) より十分短い周期にすること。
const SAVE_PDF_HEARTBEAT_INTERVAL_MS = 1000;

/**
 * payload から元 PDF bytes を取得する。
 * - bytes 指定: 従来経路（main thread から transfer された Uint8Array をそのまま使う）
 * - url 指定: Worker 内で直接 fetch → arrayBuffer する経路。
 *   main thread heap を経由しないので 100MB 級 PDF でも OOM しない。
 * 両方指定された場合は bytes を優先。
 */
async function resolvePdfBytes(data: {
  bytes?: Uint8Array;
  url?: string;
}): Promise<Uint8Array> {
  if (data.bytes) return data.bytes;
  if (data.url) {
    // main thread 側の savePDF にもハードタイムアウトがあるが、Worker 内で
    // fetch 自体が無応答になった場合でも明示的に abort できるよう、ここでも
    // AbortController を掛けておく（defense in depth）。
    const controller = new AbortController();
    const abortId = setTimeout(() => controller.abort(), 90_000);
    try {
      const res = await fetch(data.url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`[pdf.worker] fetch failed: ${res.status} ${res.statusText}`);
      }
      const buf = await res.arrayBuffer();
      return new Uint8Array(buf);
    } finally {
      clearTimeout(abortId);
    }
  }
  throw new Error('[pdf.worker] SAVE_PDF payload missing both bytes and url');
}

self.onmessage = async (e: MessageEvent<SavePdfWorkerRequest>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'SAVE_PDF': {
      // PCT-194 (#425): 処理中は heartbeat を周期送信し、main 殻が「生きている保存」を
      // 進捗ベースで判定できるようにする。成功/失敗いずれの応答後も必ず停止する。
      const heartbeatId = setInterval(() => {
        const heartbeat: SavePdfWorkerResponse = { type: 'SAVE_PDF_HEARTBEAT' };
        self.postMessage(heartbeat);
      }, SAVE_PDF_HEARTBEAT_INTERVAL_MS);
      try {
        const { documentState, fallbackFontBytes, fontBytes, pageOrder, options } = msg.data;
        const originalPdfBytes = await resolvePdfBytes(msg.data);
        // M-1 (bug-hunt): ページ処理粒度の明示 heartbeat。実 worker 実行時のみ配線する
        // （__handleSavePdfForTest 経由の直接呼び出しでは onProgress は渡されず no-op）。
        const sendHeartbeat = () => {
          const heartbeat: SavePdfWorkerResponse = { type: 'SAVE_PDF_HEARTBEAT' };
          self.postMessage(heartbeat);
        };
        const { savedBytes, skippedChars, bytePreserved } = await handleSavePdf(originalPdfBytes, documentState, fontBytes, fallbackFontBytes, pageOrder, options, sendHeartbeat);
        const response: SavePdfWorkerResponse = { type: 'SAVE_PDF_SUCCESS', data: savedBytes, skippedChars, bytePreserved };
        self.postMessage(response, [savedBytes.buffer]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const response: SavePdfWorkerResponse = { type: 'ERROR', message };
        self.postMessage(response);
      } finally {
        clearInterval(heartbeatId);
      }
      break;
    }
    default: {
      // 網羅性チェック: 新しい request type を追加した時にコンパイルエラーで気づけるようにする。
      const _exhaustive: never = msg.type;
      void _exhaustive;
      break;
    }
  }
};
