import { PecoDocument } from '../types';
import {
  stripTextBlocks,
} from './pdfContentStream';
import {
  buildPdfDocumentCore,
} from './pdfSaverCore';
import type {
  SavePdfSource,
  SavePdfWorkerRequest,
  SavePdfWorkerResponse,
  SerializedPageData,
  SkippedPdfTextChar,
} from './pdfWorkerTypes';
import type { SaveDialogOptions } from '../hooks/useFileOperations';

// テスト互換のため再輸出（src/__tests__/unit/pdfSaver.stripTextBlocks.repro.test.ts 等）
export { stripTextBlocks };
// テスト互換のため再輸出（src/__tests__/unit/pdfSaverDescentRatio.test.ts）
export { getFontDescentRatio } from './pdfSaverCore';


/**
 * Common PDF building logic.
 * Uses incremental update to only write changed pages.
 * Performs surgical removal of old text layers to prevent "Double OCR".
 * Sweeps unreachable indirect objects before save (issue #96)
 *   so that re-loading and re-saving a bloated PDF converges to a normal size.
 * Powered by @cantoo/pdf-lib.
 */

/**
 * 保存対象の元 PDF ソース指定:
 * - Uint8Array を直接渡す（従来互換）
 * - `SavePdfSource`（{bytes} / {url}）を渡す。URL 経路は main thread 側で
 *   fetch → arrayBuffer する（Worker 経路では pdf.worker.ts 内で fetch するため
 *   main thread heap を経由しない）
 */
export type BuildPdfSource = Uint8Array | SavePdfSource;

async function resolveBuildPdfSource(source: BuildPdfSource): Promise<Uint8Array> {
  if (source instanceof Uint8Array) return source;
  if (source.bytes) return source.bytes;
  const res = await fetch(source.url);
  if (!res.ok) {
    throw new Error(`[buildPdfDocument] fetch failed: ${res.status} ${res.statusText}`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

/** BuildPdfSource から bytes 経路の Uint8Array を抽出する（無ければ null） */
function extractBytes(source: BuildPdfSource): Uint8Array | null {
  if (source instanceof Uint8Array) return source;
  return source.bytes ?? null;
}

/** BuildPdfSource から URL を抽出する（無ければ null） */
function extractUrl(source: BuildPdfSource): string | null {
  if (source instanceof Uint8Array) return null;
  return source.url ?? null;
}

export async function buildPdfDocument(
  source: BuildPdfSource,
  documentState: PecoDocument,
  fontBytes?: ArrayBuffer,
  fallbackFontBytes: ArrayBuffer[] = [],
  onSkippedChars?: (chars: SkippedPdfTextChar[]) => void,
  pageOrder?: number[],
  options?: SaveDialogOptions,
  // P1-1/M-4 (bug-hunt): core の byte-preserve 判定 (undecodable 早期 return) を呼び出し元へ
  // 伝える。skippedChars と同じ D3 パターン (戻り値でなくコールバック) を踏襲することで、
  // 既存の savePDF/buildPdfDocument 呼び出し元・テストモック（Uint8Array 戻り値前提）を
  // 一切変更せずに済む。
  onBytePreserved?: (bytePreserved: boolean) => void,
): Promise<Uint8Array> {
  // D2: main 殻が fetch を担当し、解決済み Uint8Array を core に渡す。
  const originalPdfBytes = await resolveBuildPdfSource(source);

  // D1: pages を Map<number, SerializedPageData> に正規化 (thumbnail 除去)。
  const serializedPages = new Map<number, SerializedPageData>();
  for (const [idx, page] of documentState.pages.entries()) {
    const { thumbnail: _t, ...pageWithoutThumbnail } = page;
    serializedPages.set(idx, pageWithoutThumbnail);
  }

  // D4: main 殻は saveTimeoutMs を渡さない (race なし)。
  const { savedBytes, skippedChars, bytePreserved } = await buildPdfDocumentCore(
    originalPdfBytes,
    { totalPages: documentState.totalPages, pages: serializedPages },
    fontBytes,
    fallbackFontBytes,
    { options, pageOrder },
  );

  // D3: main 殻がコールバック変換を担う。
  onSkippedChars?.(skippedChars);
  onBytePreserved?.(bytePreserved);
  return savedBytes;
}


let activeSaveWorker: Worker | null = null;
let currentSaveTask: Promise<Uint8Array> | null = null;
// 先行保存タスクを外部（次の savePDF 呼び出し）から reject するためのハンドル。
// PREVIOUS_SAVE_TIMEOUT_MS 経過で stale worker を terminate する際、terminate は
// 先行タスクの Promise を settle させない（onmessage/onerror が発火しないため）。
// これを保持しておき、terminate と同時に明示 reject して宙吊りを防ぐ（#425）。
let currentSaveReject: ((err: unknown) => void) | null = null;
// PCT-194 (#425): 進捗ベースの生存判定用タイムスタンプ。worker タスク開始時、および
// SAVE_PDF_HEARTBEAT 受信のたびに更新する。「前回タスクが完了したか」ではなく
// 「前回タスクの worker が最後に何か通知してきたのはいつか」を基準にすることで、
// 5秒を超える正常な保存中でも heartbeat が続く限り誤 terminate しないようにする。
// worker が使えない main-thread fallback 経路（Worker API 不在）では heartbeat が
// 存在しないため、タスク開始時刻のまま固定される（従来どおりの固定タイムアウト挙動）。
let lastSaveActivityAt = 0;

// 前回保存の生存判定に使う「heartbeat 無応答許容時間」。この時間内に heartbeat
// （または worker が使えない場合はタスク完了）が無ければ stale とみなして terminate する。
const PREVIOUS_SAVE_TIMEOUT_MS = 5000;
// 保存全体のハードタイムアウト。Worker 内で fetch や pdf-lib が想定外に無応答に
// なった場合でも、ここで強制的に reject して呼び出し側に失敗を返す。
const SAVE_HARD_TIMEOUT_MS = 120_000;

/**
 * Worker を生成するファクトリ。テストからの差し替えを容易にするため internal export。
 * 本番では `new Worker(new URL('./pdf.worker.ts', import.meta.url), { type: 'module' })` が使われる。
 * Worker API が利用できない環境（JSDOM 等）では null を返し、呼び出し側で main thread 実行にフォールバックする。
 */
export type SaveWorkerFactory = () => Worker | null;

let createSaveWorker: SaveWorkerFactory = () => {
  if (typeof Worker === 'undefined') return null;
  return new Worker(new URL('./pdf.worker.ts', import.meta.url), { type: 'module' });
};

/** テスト用: Worker ファクトリを差し替える（テスト後は __resetSaveWorkerFactory で元に戻す） */
export function __setSaveWorkerFactoryForTest(factory: SaveWorkerFactory): void {
  createSaveWorker = factory;
}

/** テスト用: savePDF のモジュール状態（activeSaveWorker / currentSaveTask）をリセット */
export function __resetSaveStateForTest(): void {
  if (activeSaveWorker) {
    try { activeSaveWorker.terminate(); } catch { /* noop */ }
  }
  activeSaveWorker = null;
  currentSaveTask = null;
  currentSaveReject = null;
  lastSaveActivityAt = 0;
}

export async function savePDF(
  source: BuildPdfSource,
  documentState: PecoDocument,
  fontBytes?: ArrayBuffer,
  fallbackFontBytes: ArrayBuffer[] = [],
  onSkippedChars?: (chars: SkippedPdfTextChar[]) => void,
  pageOrder?: number[],
  options?: SaveDialogOptions,
  // P1-1/M-4 (bug-hunt): worker殻/main殻 両経路で core の bytePreserved 判定を素通しする。
  onBytePreserved?: (bytePreserved: boolean) => void,
): Promise<Uint8Array> {
  const sourceBytes = extractBytes(source);
  const sourceUrl = extractUrl(source);
  // 前回の保存が未完了の場合、完了 or 「heartbeat 無応答が一定時間続く」まで待ってから
  // 新 worker を起動する（PCT-194 / #425: 進捗ベースの生存判定）。
  // 固定 5 秒待ちではなく、直近の活動（タスク開始 or heartbeat）からの経過時間を
  // 都度再計算するループにすることで、5 秒を超える正常な保存でも heartbeat が
  // 続いている限り誤 terminate しない。
  while (currentSaveTask) {
    const elapsedSinceActivity = Date.now() - lastSaveActivityAt;
    const remainingMs = PREVIOUS_SAVE_TIMEOUT_MS - elapsedSinceActivity;
    if (remainingMs <= 0) {
      console.warn('[savePDF] Previous save did not complete within timeout (no heartbeat); terminating stale worker.');
      if (activeSaveWorker) {
        try { activeSaveWorker.terminate(); } catch { /* noop: terminate の二重呼び出しは無害扱い */ }
        activeSaveWorker = null;
      }
      // terminate は先行タスクの Promise を settle させない（onmessage/onerror が
      // 発火しないため）。放置すると SAVE_HARD_TIMEOUT_MS(120秒) まで宙吊りになる
      // （#425）。ここで明示的に reject し、呼び出し側へ速やかに失敗を伝える。
      if (currentSaveReject) {
        currentSaveReject(new Error('後続の保存操作により、前回の保存が中断されました。もう一度保存してください。'));
        currentSaveReject = null;
      }
      currentSaveTask = null;
      break;
    }

    const timeoutSymbol = Symbol('timeout-check');
    const timeoutPromise = new Promise<typeof timeoutSymbol>((resolve) => {
      setTimeout(() => resolve(timeoutSymbol), remainingMs);
    });
    try {
      const raceResult = await Promise.race([
        currentSaveTask.then(() => 'done' as const, () => 'done' as const),
        timeoutPromise,
      ]);
      if (raceResult === 'done') break;
      // それ以外は「残り時間だけ待った結果、まだ完了していない」ケース。ループ先頭に
      // 戻って最新の lastSaveActivityAt から remainingMs を再計算する
      // （その間に heartbeat が来ていれば延命、来ていなければ次の周でterminateに至る）。
    } catch {
      // 前回タスクの reject は無視（既に解決済み扱い）
      break;
    }
  }

  const task = new Promise<Uint8Array>((resolve, reject) => {
    let settled = false;
    let hardTimeoutId: ReturnType<typeof setTimeout> | null = null;
    // このタスク専用の reject ハンドル。currentSaveReject には常にこの参照を
    // 登録する（下の代入部を参照）。settle 時は自分が current の場合のみクリアし、
    // 既に次のタスクに上書きされていれば触らない（多重タスクの取り違え防止）。
    const myReject = (err: unknown) => {
      if (settled) return;
      settled = true;
      if (hardTimeoutId !== null) clearTimeout(hardTimeoutId);
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const settleResolve = (value: Uint8Array) => {
      if (settled) return;
      settled = true;
      if (hardTimeoutId !== null) clearTimeout(hardTimeoutId);
      if (currentSaveReject === myReject) currentSaveReject = null;
      resolve(value);
    };
    const settleReject = (err: unknown) => {
      if (currentSaveReject === myReject) currentSaveReject = null;
      myReject(err);
    };

    let worker: Worker | null = null;
    try {
      worker = createSaveWorker();
      if (!worker) {
        // Worker API 不在: main thread で直接実行。
        // heartbeat が無い経路のため、タスク開始時刻を活動時刻として記録し
        // 「従来どおりの固定タイムアウト待機」を維持する（レビューHIGH: 未設定だと
        // 前回保存の待機猶予がゼロになり保存が並走しうる）。
        lastSaveActivityAt = Date.now();
        buildPdfDocument(source, documentState, fontBytes, fallbackFontBytes, onSkippedChars, pageOrder, options, onBytePreserved)
          .then(settleResolve)
          .catch(settleReject);
        return;
      }
      const activeWorker = worker;
      activeSaveWorker = activeWorker;
      // stale worker として terminate された際に先行 Promise を reject できるよう登録。
      currentSaveReject = myReject;
      // PCT-194 (#425): このタスクの「生存基準時刻」をタスク開始時点にセットする。
      // 以降 SAVE_PDF_HEARTBEAT を受信するたびに更新され、次の savePDF 呼び出しが
      // stale 判定に使う。
      lastSaveActivityAt = Date.now();

      const cleanup = () => {
        if (activeSaveWorker === activeWorker) activeSaveWorker = null;
        // terminate は idempotent: 二重呼び出しでも例外にならない。
        try { activeWorker.terminate(); } catch { /* noop */ }
      };

      // Worker が想定外に無応答になった場合のハードタイムアウト。
      // 正常経路では success/error 受領時に clearTimeout される。
      hardTimeoutId = setTimeout(() => {
        if (settled) return;
        console.warn('[savePDF] hard timeout reached; terminating worker.');
        cleanup();
        settleReject(new Error('保存がタイムアウトしました。'));
      }, SAVE_HARD_TIMEOUT_MS);

      activeWorker.onmessage = (e: MessageEvent<SavePdfWorkerResponse>) => {
        if (settled) return;
        const msg = e.data;
        if (msg.type === 'SAVE_PDF_HEARTBEAT') {
          // PCT-194 (#425): worker が生きていることの周期通知。生存基準時刻を更新するのみ
          // で、このタスク自体は settle しない。
          lastSaveActivityAt = Date.now();
        } else if (msg.type === 'SAVE_PDF_SUCCESS') {
          cleanup();
          onSkippedChars?.(msg.skippedChars ?? []);
          onBytePreserved?.(msg.bytePreserved ?? false);
          settleResolve(msg.data);
        } else if (msg.type === 'ERROR') {
          cleanup();
          settleReject(new Error(msg.message));
        }
      };

      activeWorker.onerror = (err) => {
        if (settled) return;
        if (typeof err?.preventDefault === 'function') err.preventDefault();
        cleanup();
        const details = err instanceof ErrorEvent
          ? [
              err.message,
              err.filename ? `${err.filename}:${err.lineno}:${err.colno}` : '',
              err.error instanceof Error ? err.error.stack : '',
            ].filter(Boolean).join('\n')
          : String(err);
        settleReject(new Error(details || 'PDF保存ワーカーでエラーが発生しました。'));
      };

      activeWorker.onmessageerror = (err) => {
        if (settled) return;
        cleanup();
        settleReject(new Error(`PDF保存ワーカーとの通信に失敗しました: ${String(err)}`));
      };

      const serializedPages: Record<number, SerializedPageData> = {};
      for (const [idx, page] of documentState.pages.entries()) {
        // thumbnail は Worker 内で不要な blob URL であるため除去する
        const { thumbnail: _t, ...pageWithoutThumbnail } = page;
        serializedPages[idx] = pageWithoutThumbnail;
      }

      const transferables: Transferable[] = [];
      // TODO(#184): 現状 save worker を毎回 spawn するため、保存のたびに
      // フォントバイト列 (Meiryo ~3MB + fallbacks 数MB) を slice() で full copy
      // して transfer している。本来は save worker をシングルトン化して
      // 初回 LOAD で 1 度だけフォントを送り、以降は ArrayBuffer をプールから
      // 再利用したい。要・別 enhancement issue で対応。当面は安全側で
      // 都度 clone のまま維持 (worker への transfer はメインヒープを破壊するため
      // 短命 worker と心中させる現方針が事故率は低い)。
      const fontBytesClone = fontBytes instanceof ArrayBuffer ? fontBytes.slice(0) : undefined;
      if (fontBytesClone) transferables.push(fontBytesClone);
      const fallbackFontBytesClone = fallbackFontBytes.map((bytes) => bytes.slice(0));
      for (const bytes of fallbackFontBytesClone) transferables.push(bytes);

      // URL 経路は Worker 内で直接 fetch するため main thread heap を経由しない。
      // bytes 経路は従来どおり buffer を transfer する。
      // bytes が取れれば優先 (fetch 不要)、取れなければ url を Worker に転送する。
      let sourcePayload: SavePdfSource;
      if (sourceBytes) {
        const bytesClone = sourceBytes.slice();
        transferables.push(bytesClone.buffer);
        sourcePayload = { bytes: bytesClone };
      } else if (sourceUrl) {
        sourcePayload = { url: sourceUrl };
      } else {
        throw new Error('[savePDF] source must contain bytes or url');
      }

      const request: SavePdfWorkerRequest = {
        type: 'SAVE_PDF',
        data: {
          ...sourcePayload,
          documentState: { ...documentState, pages: serializedPages },
          fontBytes: fontBytesClone,
          fallbackFontBytes: fallbackFontBytesClone,
          pageOrder,
          options,
        },
      };
      activeWorker.postMessage(request, transferables);
    } catch (err) {
      if (worker) {
        try { worker.terminate(); } catch { /* noop */ }
      }
      if (activeSaveWorker === worker) activeSaveWorker = null;
      console.warn('[savePDF] Worker creation failed, falling back to main thread:', err);
      // fallback 経路にも活動時刻を記録（レビューHIGH: 上の Worker 不在分岐と同旨）。
      lastSaveActivityAt = Date.now();
      buildPdfDocument(source, documentState, fontBytes, fallbackFontBytes, onSkippedChars, pageOrder, options, onBytePreserved)
        .then(settleResolve)
        .catch(settleReject);
    }
  });

  currentSaveTask = task;
  try {
    return await task;
  } finally {
    if (currentSaveTask === task) currentSaveTask = null;
  }
}

