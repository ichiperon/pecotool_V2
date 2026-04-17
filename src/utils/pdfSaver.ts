import {
  PDFDocument, StandardFonts, degrees, pushGraphicsState, popGraphicsState,
  translate, scale, PDFName, PDFHexString, PDFString, PDFRawStream, PDFArray,
  PDFDict, PDFRef, PDFObject
} from '@cantoo/pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { PecoDocument } from '../types';
import { inflate } from 'pako';
import type {
  SavePdfWorkerRequest,
  SavePdfWorkerResponse,
  SerializedPageData,
} from './pdfWorkerTypes';

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
 * Strips all text blocks (BT...ET) from a decoded (uncompressed) content stream.
 * BT and ET must appear as standalone tokens (surrounded by whitespace or line boundaries)
 * to avoid accidentally matching binary data that happens to contain those byte sequences.
 * The input MUST be already decoded bytes — do NOT pass raw/compressed stream contents.
 * We use 'latin1' so each byte maps 1:1 to a character, avoiding UTF-8 corruption.
 */
/**
 * Strips all text blocks (BT...ET) from a decoded (uncompressed) content stream.
 * Optimized to work directly on Uint8Array to avoid expensive string conversions and regex.
 */
function stripTextBlocks(decoded: Uint8Array): Uint8Array {
  const result = new Uint8Array(decoded.length);
  let resultIdx = 0;
  let i = 0;
  const len = decoded.length;

  while (i < len) {
    // Look for "BT" (Begin Text)
    // Must be preceded by delimiter (space, tab, newline, (, [, <, /, %) or start of stream
    // and followed by delimiter.
    if (
      decoded[i] === 0x42 && decoded[i+1] === 0x54 && // 'BT'
      (i === 0 || decoded[i-1] <= 0x20 || decoded[i-1] === 0x28 || decoded[i-1] === 0x5b || decoded[i-1] === 0x3c || decoded[i-1] === 0x2f || decoded[i-1] === 0x25) && 
      (i + 2 === len || decoded[i+2] <= 0x20 || decoded[i+2] === 0x28 || decoded[i+2] === 0x5b || decoded[i+2] === 0x3c || decoded[i+2] === 0x2f || decoded[i+2] === 0x25)
    ) {
      // Found BT, skip until "ET" (End Text)
      i += 2;
      while (i < len) {
        if (
          decoded[i] === 0x45 && decoded[i+1] === 0x54 && // 'ET'
          (i === 0 || decoded[i-1] <= 0x20 || decoded[i-1] === 0x28 || decoded[i-1] === 0x5b || decoded[i-1] === 0x3c || decoded[i-1] === 0x2f || decoded[i-1] === 0x25) &&
          (i + 2 === len || decoded[i+2] <= 0x20 || decoded[i+2] === 0x28 || decoded[i+2] === 0x5b || decoded[i+2] === 0x3c || decoded[i+2] === 0x2f || decoded[i+2] === 0x25)
        ) {
          i += 2;
          break;
        }
        i++;
      }
    } else {
      result[resultIdx++] = decoded[i++];
    }
  }

  return result.slice(0, resultIdx);
}

/**
 * Common PDF building logic.
 * Uses incremental update to only write changed pages.
 * Performs surgical removal of old text layers to prevent "Double OCR".
 * Powered by @cantoo/pdf-lib.
 */

export async function buildPdfDocument(
  originalPdfBytes: Uint8Array,
  documentState: PecoDocument,
  fontBytes?: ArrayBuffer
): Promise<Uint8Array> {
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
      if (value instanceof PDFHexString) {
        existingBBoxMeta = JSON.parse(value.decodeText());
      } else if (value instanceof PDFString) {
        existingBBoxMeta = JSON.parse(value.decodeText());
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

  // update: true = incremental update: original PDF bytes are preserved at the
  // front of the output, so the original PDF version and structure are retained as-is.
  // This ensures compatibility with older viewers such as Acrobat 7 (supports up to PDF 1.6).
  // update:true は @cantoo/pdf-lib の拡張オプション（型定義には無いが実装側で受理される）
  const saveOptions: Parameters<typeof pdfDoc.save>[0] & { update?: boolean } = {
    useObjectStreams: false,
    addDefaultPage: false,
    update: true,
  };
  const savedBytes = await pdfDoc.save(saveOptions);
  return savedBytes;
}


let activeSaveWorker: Worker | null = null;
let currentSaveTask: Promise<Uint8Array> | null = null;

const PREVIOUS_SAVE_TIMEOUT_MS = 5000;

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
  originalPdfBytes: Uint8Array,
  documentState: PecoDocument,
  fontBytes?: ArrayBuffer
): Promise<Uint8Array> {
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
    const settleResolve = (value: Uint8Array) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const settleReject = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    let worker: Worker | null = null;
    try {
      worker = createSaveWorker();
      if (!worker) {
        // Worker API 不在: main thread で直接実行
        buildPdfDocument(originalPdfBytes, documentState, fontBytes)
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

      const bytesClone = originalPdfBytes.slice();
      const transferables: Transferable[] = [bytesClone.buffer];
      const fontBytesClone = fontBytes instanceof ArrayBuffer ? fontBytes.slice(0) : undefined;
      if (fontBytesClone) transferables.push(fontBytesClone);

      const request: SavePdfWorkerRequest = {
        type: 'SAVE_PDF',
        data: {
          originalPdfBytes: bytesClone,
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
      buildPdfDocument(originalPdfBytes, documentState, fontBytes)
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

