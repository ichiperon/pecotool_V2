import {
  PDFDocument, StandardFonts, degrees, pushGraphicsState, popGraphicsState,
  translate, scale, PDFName, PDFHexString, PDFString, PDFRawStream, PDFArray,
  PDFDict, PDFRef, PDFObject
} from '@cantoo/pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { PecoDocument } from '../types';
import { inflate } from 'pako';
import { stripTextBlocks } from './pdfContentStream';
import { extractPdfVersion, restorePdfVersion } from './pdfVersion';
import { safeDecodePdfText } from './pdfLibSafeDecode';
import type {
  SavePdfSource,
  SavePdfWorkerRequest,
  SavePdfWorkerResponse,
  SerializedPageData,
} from './pdfWorkerTypes';

// テスト互換のため再輸出（src/__tests__/unit/pdfSaver.stripTextBlocks.repro.test.ts 等）
export { stripTextBlocks };

/**
 * Decompress a PDFRawStream's contents.
 * Handles FlateDecode (the overwhelmingly common case in modern PDFs).
 * Falls back to returning the raw bytes for unrecognized or absent filters.
 */
/**
 * Returns decompressed stream contents, or null if decoding failed / unsupported filter.
 * Callers must skip stream modification when null is returned.
 */
function decodeStreamContents(stream: PDFRawStream): Uint8Array | null {
  const filter = stream.dict.lookup(PDFName.of('Filter'));
  const raw = stream.getContents();

  // Resolve filter names — Filter can be a single PDFName or a PDFArray of names.
  let filterNames: string[];
  if (filter instanceof PDFName) {
    filterNames = [filter.asString()];
  } else if (filter instanceof PDFArray) {
    // Use .asArray() — PDFArray does NOT expose a .array property
    // asArray() が返すのは PDFObject[] だが Filter 配列の実体は PDFName のみ
    filterNames = filter.asArray().map((f) => (f as PDFName).asString());
  } else if (!filter) {
    // No filter — raw bytes are already plain content operators
    return raw;
  } else {
    // Unknown filter type — skip modification to avoid corrupting the stream
    return null;
  }

  if (filterNames.length === 0) return raw;

  // Only handle a single /FlateDecode; multi-filter chains are left untouched.
  if (filterNames.length === 1 && filterNames[0] === '/FlateDecode') {
    try {
      return inflate(raw);
    } catch {
      return null;
    }
  }

  // Unsupported filter (LZW, ASCII85, multi-filter chain, etc.) — skip modification
  return null;
}

/**
 * Common PDF building logic.
 * Uses incremental update to only write changed pages.
 * Performs surgical removal of old text layers to prevent "Double OCR".
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
  fontBytes?: ArrayBuffer
): Promise<Uint8Array> {
  const originalPdfBytes = await resolveBuildPdfSource(source);
  const originalVersion = extractPdfVersion(originalPdfBytes);
  // forIncrementalUpdate + commit() を試したが、subset embedFont と組み合わせると
  // fontkit 生成 subset の glyf table が OTS 検証をパスしない状態 (Acrobat でも
  // 「フォントを抽出できません」) になる。ベンチ実測では pdfDoc.save() 全書き換えと
  // commit() incremental は 91ms vs 126ms でほぼ同速なので、安全側の全書き換えに戻す。
  // throwOnInvalidObject:false → 不正オブジェクトの回復試行をスキップして高速化
  // updateMetadata:false → 更新日時の自動書き換えを抑制
  const pdfDoc = await PDFDocument.load(originalPdfBytes, {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
  pdfDoc.registerFontkit(fontkit);

  const dirtyPages = Array.from(documentState.pages.entries()).filter(([, pageData]) => pageData.isDirty);
  
  // Only embed font if we actually have something to draw
  const needsFont = dirtyPages.some(([, pageData]) => 
    pageData.textBlocks.some(b => b.text && b.text.trim() !== '')
  );

  // フォントは TTF 形式で供給する必要がある。WOFF2 を直接食わせると fontkit が
  // loca/glyf を正しく出力できず、OTS 検証で「フォント抽出不能」になる。
  // ベンチで実 PDF roundtrip 検証済み: TTF + subset:true → warning ゼロ、
  // output size は原本と同じ (subset ~200KB のみ追加)。
  const customFont = needsFont
    ? (fontBytes
        ? await pdfDoc.embedFont(fontBytes, { subset: true })
        : await pdfDoc.embedFont(StandardFonts.Helvetica))
    : null;

  // getInfoDict() は pdf-lib の public API には無いため、型アサーションで呼び出す
  const infoDict = (pdfDoc as unknown as { getInfoDict(): PDFDict | undefined }).getInfoDict();
  let existingBBoxMeta: Record<string, unknown> = {};

  if (infoDict) {
    try {
      const value = infoDict.get(PDFName.of('PecoToolBBoxes'));
      // decodeText() は数 MB のメタで stack overflow するため safeDecodePdfText を使う
      if (value instanceof PDFHexString || value instanceof PDFString) {
        existingBBoxMeta = JSON.parse(safeDecodePdfText(value));
      }
    } catch { /* ignore parse errors */ }
  }

  const bboxMeta = { ...existingBBoxMeta };
  let metaChanged = false;

  for (const [pageIndexStr, pageData] of dirtyPages) {
    const pageIndex = typeof pageIndexStr === 'string' ? parseInt(pageIndexStr, 10) : pageIndexStr;
    
    const sortedBlocks = [...pageData.textBlocks].sort((a, b) => a.order - b.order);
    bboxMeta[String(pageIndex)] = sortedBlocks.map(b => ({
      bbox: b.bbox,
      writingMode: b.writingMode,
      order: b.order,
      text: b.text
    }));
    metaChanged = true;

    const page = pdfDoc.getPage(pageIndex);
    const { height } = page.getSize();

    // --- Surgical Text Stripping ---
    // page.node の Contents() は pdf-lib の public API に型定義が無い
    const contentStreamsRef = (page.node as unknown as { Contents(): PDFObject | PDFRef | undefined }).Contents();
    if (contentStreamsRef) {
      const resolved = pdfDoc.context.lookup(contentStreamsRef);
      let streams: PDFObject[] = [];
      if (resolved instanceof PDFArray) {
        streams = resolved.asArray();
      } else {
        streams = [contentStreamsRef];
      }
      const newStreams: PDFObject[] = [];
      for (const streamRef of streams) {
        const stream = pdfDoc.context.lookup(streamRef);
        if (stream instanceof PDFRawStream) {
          const decoded = decodeStreamContents(stream);
          if (decoded !== null) {
            const cleaned = stripTextBlocks(decoded);
            const newStream = pdfDoc.context.flateStream(cleaned);
            newStreams.push(pdfDoc.context.register(newStream));
          } else {
            newStreams.push(streamRef);
          }
        } else {
          newStreams.push(streamRef);
        }
      }
      page.node.set(PDFName.of('Contents'), pdfDoc.context.obj(newStreams));
    }

    if (!customFont) continue;

    // Now draw the NEW text blocks onto the cleaned page
    for (const block of sortedBlocks) {
      if (!block.text) continue;

      try {
        const fontSize = 1;
        const textWidth = customFont.widthOfTextAtSize(block.text, fontSize);
        const textHeight = customFont.heightAtSize(fontSize);
        
        if (textWidth === 0 || textHeight === 0) {
          console.warn(`[buildPdfDocument] Page ${pageIndex}: skipped block (zero font metrics) text="${block.text.slice(0, 20)}"`);
          continue;
        }

        if (block.writingMode === 'vertical') {
          const sx = block.bbox.width / textHeight;
          const sy = block.bbox.height / textWidth;

          if (!isFinite(sx) || !isFinite(sy)) {
            console.warn(`[buildPdfDocument] Page ${pageIndex}: skipped block (non-finite scale sx=${sx} sy=${sy}) text="${block.text.slice(0, 20)}"`);
            continue;
          }

          const baselineX = block.bbox.x + textHeight * sx * 0.2;
          const baselineY = height - block.bbox.y;

          page.pushOperators(pushGraphicsState(), translate(baselineX, baselineY), scale(sx, sy));
          page.drawText(block.text, { x: 0, y: 0, size: fontSize, font: customFont, rotate: degrees(-90), opacity: 0 });
          page.pushOperators(popGraphicsState());
        } else {
          const sx = block.bbox.width / textWidth;
          const sy = block.bbox.height / textHeight;
          
          if (!isFinite(sx) || !isFinite(sy)) {
            console.warn(`[buildPdfDocument] Page ${pageIndex}: skipped block (non-finite scale sx=${sx} sy=${sy}) text="${block.text.slice(0, 20)}"`);
            continue;
          }

          const baselineY = height - block.bbox.y - textHeight * sy * 0.8;

          page.pushOperators(pushGraphicsState(), translate(block.bbox.x, baselineY), scale(sx, sy));
          page.drawText(block.text, { x: 0, y: 0, size: fontSize, font: customFont, opacity: 0 });
          page.pushOperators(popGraphicsState());
        }
      } catch(e) {
        console.warn(`[buildPdfDocument] Page ${pageIndex} block error:`, e);
      }
    }
  }

  if (metaChanged && infoDict) {
    infoDict.set(PDFName.of('PecoToolBBoxes'), PDFHexString.fromText(JSON.stringify(bboxMeta)));
  }

  // Acrobat 7.0 互換性のため useObjectStreams:false で旧形式 xref を維持する。
  // save() 全書き換え経路。pdf-lib は streaming serializer で、ベンチ実測では
  // 100MB PDF でも 91ms で完了する (disk write は別段の writeFileChunked で処理)。
  const saveOptions: Parameters<typeof pdfDoc.save>[0] = {
    useObjectStreams: false,
    addDefaultPage: false,
  };
  const savedBytes = await pdfDoc.save(saveOptions);
  if (originalVersion) restorePdfVersion(savedBytes, originalVersion);
  return savedBytes;
}


let activeSaveWorker: Worker | null = null;
let currentSaveTask: Promise<Uint8Array> | null = null;

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
}

export async function savePDF(
  source: BuildPdfSource,
  documentState: PecoDocument,
  fontBytes?: ArrayBuffer
): Promise<Uint8Array> {
  const sourceBytes = extractBytes(source);
  const sourceUrl = extractUrl(source);
  // 前回の保存が未完了の場合、完了 or タイムアウトまで待ってから新 worker を起動する
  if (currentSaveTask) {
    const timeoutSymbol = Symbol('timeout');
    const timeoutPromise = new Promise<typeof timeoutSymbol>((resolve) => {
      setTimeout(() => resolve(timeoutSymbol), PREVIOUS_SAVE_TIMEOUT_MS);
    });
    try {
      const raceResult = await Promise.race([
        currentSaveTask.then(() => 'done' as const, () => 'done' as const),
        timeoutPromise,
      ]);
      if (raceResult === timeoutSymbol) {
        console.warn('[savePDF] Previous save did not complete within timeout; terminating stale worker.');
        if (activeSaveWorker) {
          try { activeSaveWorker.terminate(); } catch { /* noop: terminate の二重呼び出しは無害扱い */ }
          activeSaveWorker = null;
        }
        currentSaveTask = null;
      }
    } catch {
      // 前回タスクの reject は無視（既に解決済み扱い）
    }
  }

  const task = new Promise<Uint8Array>((resolve, reject) => {
    let settled = false;
    let hardTimeoutId: ReturnType<typeof setTimeout> | null = null;
    const settleResolve = (value: Uint8Array) => {
      if (settled) return;
      settled = true;
      if (hardTimeoutId !== null) clearTimeout(hardTimeoutId);
      resolve(value);
    };
    const settleReject = (err: unknown) => {
      if (settled) return;
      settled = true;
      if (hardTimeoutId !== null) clearTimeout(hardTimeoutId);
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    let worker: Worker | null = null;
    try {
      worker = createSaveWorker();
      if (!worker) {
        // Worker API 不在: main thread で直接実行
        buildPdfDocument(source, documentState, fontBytes)
          .then(settleResolve)
          .catch(settleReject);
        return;
      }
      const activeWorker = worker;
      activeSaveWorker = activeWorker;

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
        if (msg.type === 'SAVE_PDF_SUCCESS') {
          cleanup();
          settleResolve(msg.data);
        } else if (msg.type === 'ERROR') {
          cleanup();
          settleReject(new Error(msg.message));
        }
      };

      activeWorker.onerror = (err) => {
        if (settled) return;
        cleanup();
        settleReject(err);
      };

      const serializedPages: Record<number, SerializedPageData> = {};
      for (const [idx, page] of documentState.pages.entries()) {
        // thumbnail は Worker 内で不要な blob URL であるため除去する
        const { thumbnail: _t, ...pageWithoutThumbnail } = page;
        serializedPages[idx] = pageWithoutThumbnail;
      }

      const transferables: Transferable[] = [];
      const fontBytesClone = fontBytes instanceof ArrayBuffer ? fontBytes.slice(0) : undefined;
      if (fontBytesClone) transferables.push(fontBytesClone);

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
        },
      };
      activeWorker.postMessage(request, transferables);
    } catch (err) {
      if (worker) {
        try { worker.terminate(); } catch { /* noop */ }
      }
      if (activeSaveWorker === worker) activeSaveWorker = null;
      console.warn('[savePDF] Worker creation failed, falling back to main thread:', err);
      buildPdfDocument(source, documentState, fontBytes)
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

