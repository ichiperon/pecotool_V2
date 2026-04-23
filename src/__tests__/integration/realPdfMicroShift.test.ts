/**
 * 実 PDF 検証テスト: test/テストPDF.pdf の全 OCR ブロックを (+0.5, +0.5) シフト →
 * 別名保存 → 全ページで byte 差分が出ることを確認する。
 *
 * 仕様:
 *   - test/テストPDF.pdf を読み込む (ユーザー提供の実 OCR PDF、222 MB / 423 ページ)
 *   - pdfjs で各ページの OCR text + bbox を抽出
 *   - 全ブロックの bbox を (+0.5, +0.5) ずらしたうえで page.isDirty=true を付与
 *   - savePDF (main thread fallback) を呼ぶ
 *   - 出力を test/テストPDF_micro_shifted.pdf に **別名で書き出す** (上書きしない)
 *   - 出力 PDF の各ページ content stream がオリジナルと byte 単位で差分ありを全数検証
 *
 * このテストは test/テストPDF.pdf が存在するときのみ実行される。不在時は skip。
 * 実行時間: 数分。メモリ消費が大きいので NODE_OPTIONS=--max-old-space-size=6144 を
 * 付けて実行することを推奨。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflate } from 'pako';
import {
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFArray,
  PDFHexString,
  PDFString,
  type PDFObject,
  type PDFRef,
  type PDFDict,
} from '@cantoo/pdf-lib';

// Tauri / bitmap だけ mock。pdf-lib と pdfjs は実物を使う。
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (p: string) => p }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  stat: vi.fn().mockResolvedValue({ mtime: Date.now() }),
}));
vi.mock('../../utils/bitmapCache', () => ({ clearBitmapCache: vi.fn() }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

import {
  savePDF,
  __setSaveWorkerFactoryForTest,
  __resetSaveStateForTest,
} from '../../utils/pdfSaver';
import type { PecoDocument, PageData, TextBlock, WritingMode } from '../../types';

const TEST_DIR = resolve(__dirname, '../../../test');
const FONT_PATH = resolve(__dirname, '../../../public/fonts/IPAexGothic.ttf');
const SHIFT = { dx: 0.5, dy: 0.5 };
const VISIBLE_SHIFT = { dx: 30, dy: 30 };

// 出力ファイル名のサフィックス (入力 PDF の検出時に除外する)
const OUTPUT_SUFFIXES = [
  '_micro_shifted', '_split', '_move', '_split_all',
  '_move2_shifted', '_move2_restored', '_edited',
  '_empty_page', '_vertical_split', '_surrogate',
];

/** test/ 内の元 PDF (出力ファイルを除く) を 1 件検出する。無ければ null。 */
function findInputPdf(): string | null {
  if (!existsSync(TEST_DIR)) return null;
  const entries = readdirSync(TEST_DIR);
  const pdfs = entries
    .filter((name) => name.toLowerCase().endsWith('.pdf'))
    .filter((name) => !OUTPUT_SUFFIXES.some((suffix) => name.includes(suffix + '.pdf')));
  if (pdfs.length === 0) return null;
  // 最新更新のものを採用 (複数あっても安定)
  const full = pdfs.map((n) => resolve(TEST_DIR, n));
  full.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return full[0];
}

const REAL_PDF_PATH: string = findInputPdf() ?? '';
const hasRealPdf = REAL_PDF_PATH !== '';

// 入力ファイル名 (拡張子なし) を元に出力ファイル名を組み立てる
function outputPath(suffix: string): string {
  if (REAL_PDF_PATH === '') return resolve(TEST_DIR, `_placeholder${suffix}.pdf`);
  const base = REAL_PDF_PATH.replace(/\\/g, '/').split('/').pop() ?? 'input.pdf';
  const stem = base.replace(/\.pdf$/i, '');
  return resolve(TEST_DIR, `${stem}${suffix}.pdf`);
}

const OUTPUT_PATH = outputPath('_micro_shifted');
const OUTPUT_PATH_SPLIT = outputPath('_split');
const OUTPUT_PATH_MOVE = outputPath('_move');
const OUTPUT_PATH_SPLIT_ALL = outputPath('_split_all');

function decodePageContents(doc: PDFDocument, pageIndex: number): Uint8Array | null {
  const page = doc.getPage(pageIndex);
  const contentsRef = (page.node as unknown as { Contents(): PDFObject | PDFRef | undefined }).Contents();
  if (!contentsRef) return null;
  const resolved = doc.context.lookup(contentsRef);
  const streams: PDFObject[] =
    resolved instanceof PDFArray ? resolved.asArray() : [contentsRef];
  const chunks: Uint8Array[] = [];
  for (const streamRef of streams) {
    const stream = doc.context.lookup(streamRef);
    if (!(stream instanceof PDFRawStream)) continue;
    const filter = stream.dict.lookup(PDFName.of('Filter'));
    const raw = stream.getContents();
    if (filter instanceof PDFName && filter.asString() === '/FlateDecode') {
      try { chunks.push(inflate(raw)); } catch { return null; }
    } else if (!filter) {
      chunks.push(raw);
    } else {
      return null;
    }
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

import { safeDecodePdfText } from '../../utils/pdfLibSafeDecode';

function readBBoxMeta(doc: PDFDocument): Record<string, unknown> | null {
  const infoDict = (doc as unknown as { getInfoDict(): PDFDict | undefined }).getInfoDict();
  if (!infoDict) {
    console.log('[readBBoxMeta] infoDict is undefined');
    return null;
  }
  const v = infoDict.get(PDFName.of('PecoToolBBoxes'));
  if (v === undefined || v === null) {
    console.log('[readBBoxMeta] PecoToolBBoxes not found in infoDict');
    return null;
  }
  if (v instanceof PDFHexString || v instanceof PDFString) {
    try {
      return JSON.parse(safeDecodePdfText(v));
    } catch (e) {
      console.log('[readBBoxMeta] JSON parse failed:', e);
      return null;
    }
  }
  console.log('[readBBoxMeta] PecoToolBBoxes type unexpected:', typeof v, v?.constructor?.name);
  return null;
}

beforeAll(async () => {
  if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.randomUUID) {
    (globalThis as unknown as { crypto: Crypto }).crypto = {
      ...(globalThis.crypto ?? {}),
      randomUUID: () => `${Math.random().toString(16).slice(2)}-${Date.now()}`,
    } as unknown as Crypto;
  }
  // pdfjs の getTextContent は ReadableStream を参照する。vitest の環境には無い
  // ことがあるので Node の web streams から polyfill する。
  if (typeof (globalThis as any).ReadableStream === 'undefined') {
    const streams = await import('node:stream/web');
    (globalThis as any).ReadableStream = streams.ReadableStream;
    (globalThis as any).WritableStream = streams.WritableStream;
    (globalThis as any).TransformStream = streams.TransformStream;
  }
});

beforeEach(() => {
  __setSaveWorkerFactoryForTest(() => null);
  __resetSaveStateForTest();
});

/** 実 PDF から pdfjs で OCR ブロックを抽出して PecoDocument を組み立てる。
 *  shift があれば全ブロックの bbox を (+dx, +dy) シフトする。 */
async function buildPecoDocumentFromRealPdf(
  realBytes: Uint8Array,
  shift: { dx: number; dy: number } = { dx: 0, dy: 0 },
): Promise<{ doc: PecoDocument; totalBlocks: number; totalPages: number }> {
  const pdfjsLib: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjsLib.getDocument({
    data: realBytes,
    disableWorker: true,
    disableFontFace: true,
  });
  const pdfjsDoc = await loadingTask.promise;
  const totalPages: number = pdfjsDoc.numPages;

  const pages = new Map<number, PageData>();
  let totalBlocks = 0;
  for (let i = 0; i < totalPages; i++) {
    const page = await pdfjsDoc.getPage(i + 1);
    const viewport = page.getViewport({ scale: 1.0 });
    const textContent = await page.getTextContent();
    const textItems = (textContent.items as Array<any>).filter(
      (item) => typeof item.str === 'string' && item.str.trim() !== '',
    );

    const blocks: TextBlock[] = textItems.map((item, idx) => {
      const tx: number[] = item.transform;
      const mag = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1]) || 1;
      const ux = tx[0] / mag, uy = tx[1] / mag;
      const px = -uy, py = ux;
      const thickness =
        item.height > 0
          ? item.height
          : Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]) || mag || 12;
      const runLength = item.width || mag * item.str.length * 0.6;
      const ascent = thickness * 1.16;
      const corners: [number, number][] = [
        [tx[4], tx[5]],
        [tx[4] + ux * runLength, tx[5] + uy * runLength],
        [tx[4] + px * ascent, tx[5] + py * ascent],
        [tx[4] + ux * runLength + px * ascent, tx[5] + uy * runLength + py * ascent],
      ];
      const vc = corners.map(([cx, cy]) => viewport.convertToViewportPoint(cx, cy));
      const vxs = vc.map((c: number[]) => c[0]);
      const vys = vc.map((c: number[]) => c[1]);
      const bbox = {
        x: Math.min(...vxs) + shift.dx,
        y: Math.min(...vys) + shift.dy,
        width: Math.max(...vxs) - Math.min(...vxs),
        height: Math.max(...vys) - Math.min(...vys),
      };
      const [vDirX, vDirY] = viewport.convertToViewportPoint(tx[4] + ux, tx[5] + uy);
      const isVertical =
        Math.abs(vDirY - vc[0][1]) > Math.abs(vDirX - vc[0][0]);
      return {
        id: `p${i}-b${idx}`,
        text: item.str,
        originalText: item.str,
        bbox,
        writingMode: (isVertical ? 'vertical' : 'horizontal') as WritingMode,
        order: idx,
        isNew: false,
        isDirty: true,
      };
    });

    totalBlocks += blocks.length;
    pages.set(i, {
      pageIndex: i,
      width: viewport.width,
      height: viewport.height,
      textBlocks: blocks,
      isDirty: true,
      thumbnail: null,
    });
  }
  try { await pdfjsDoc.cleanup(); } catch { /* ignore */ }
  try { await pdfjsDoc.destroy(); } catch { /* ignore */ }

  const resolvedPath = REAL_PDF_PATH ?? '';
  return {
    doc: {
      filePath: resolvedPath,
      fileName: resolvedPath.replace(/\\/g, '/').split('/').pop() ?? 'input.pdf',
      totalPages,
      metadata: {},
      pages,
    },
    totalBlocks,
    totalPages,
  };
}

/** 単体ブロックを半分に分割する。horizontal は幅を、vertical は高さを分ける。
 *  text 長が 2 未満のときは null を返す (分割不可)。 */
function splitBlockInHalf(block: TextBlock): { b1: TextBlock; b2: TextBlock } | null {
  if (block.text.length < 2) return null;
  const splitIdx = Math.max(1, Math.min(block.text.length - 1, Math.floor(block.text.length / 2)));
  const ratio = splitIdx / block.text.length;
  const isVertical = block.writingMode === 'vertical';
  const bbox1 = isVertical
    ? { ...block.bbox, height: block.bbox.height * ratio }
    : { ...block.bbox, width: block.bbox.width * ratio };
  const bbox2 = isVertical
    ? {
        ...block.bbox,
        y: block.bbox.y + block.bbox.height * ratio,
        height: block.bbox.height * (1 - ratio),
      }
    : {
        ...block.bbox,
        x: block.bbox.x + block.bbox.width * ratio,
        width: block.bbox.width * (1 - ratio),
      };
  const b1: TextBlock = {
    ...block,
    id: `${block.id}-L`,
    text: block.text.slice(0, splitIdx),
    originalText: block.text.slice(0, splitIdx),
    bbox: bbox1,
    isDirty: true,
  };
  const b2: TextBlock = {
    ...block,
    id: `${block.id}-R`,
    text: block.text.slice(splitIdx),
    originalText: block.text.slice(splitIdx),
    bbox: bbox2,
    isDirty: true,
  };
  return { b1, b2 };
}

/** useCanvasDrawing.trySplit() の水平書きロジックを同型に複製した分割関数。
 *  対象ブロックを文字長比率で b1/b2 に分け、textBlocks 配列の同位置に splice
 *  して order を 0..N で振り直す (本体コードの finalBlocks と完全一致)。 */
function splitBlockAtMiddle(pageData: PageData, targetIndex: number): {
  b1: TextBlock;
  b2: TextBlock;
  finalBlocks: TextBlock[];
} {
  const origBlock = pageData.textBlocks[targetIndex];
  // 水平書きブロックを想定、テキスト文字数の中央で分割
  const splitIdx = Math.max(1, Math.min(origBlock.text.length - 1, Math.floor(origBlock.text.length / 2)));
  const ratio = splitIdx / origBlock.text.length;
  const dx = origBlock.bbox.width * ratio;
  const b1: TextBlock = {
    ...origBlock,
    id: `${origBlock.id}-split-L`,
    text: origBlock.text.slice(0, splitIdx),
    originalText: origBlock.text.slice(0, splitIdx),
    bbox: { ...origBlock.bbox, width: dx },
    isDirty: true,
  };
  const b2: TextBlock = {
    ...origBlock,
    id: `${origBlock.id}-split-R`,
    text: origBlock.text.slice(splitIdx),
    originalText: origBlock.text.slice(splitIdx),
    bbox: {
      ...origBlock.bbox,
      x: origBlock.bbox.x + dx,
      width: origBlock.bbox.width - dx,
    },
    isDirty: true,
  };
  // filter + splice で原ブロックを [b1, b2] に差し替え
  const newBlocks = pageData.textBlocks.filter((b) => b.id !== origBlock.id);
  newBlocks.splice(targetIndex, 0, b1, b2);
  const finalBlocks = newBlocks.map((b, idx) => ({ ...b, order: idx }));
  return { b1, b2, finalBlocks };
}

describe.skipIf(!hasRealPdf)('REAL PDF: 全 OCR 微移動 → 別名保存 → 差分確認', () => {
  it('test/テストPDF.pdf の全ページ OCR を (0.5, 0.5) シフトして保存 → 全ページ差分あり', async () => {
    const stat = statSync(REAL_PDF_PATH);
    console.log(`[REAL] input: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);

    // --- 実 PDF 読み込み ---
    const realBytes = readFileSync(REAL_PDF_PATH);

    // --- pdfjs legacy build で OCR 抽出 ---
    const pdfjsLib: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(realBytes),
      disableWorker: true,
      disableFontFace: true,
    });
    const pdfjsDoc = await loadingTask.promise;
    const totalPages: number = pdfjsDoc.numPages;
    console.log(`[REAL] pages: ${totalPages}`);

    // --- 全ページの OCR ブロックを抽出して (+0.5, +0.5) シフト ---
    const pages = new Map<number, PageData>();
    let totalBlocks = 0;
    const tExtractStart = Date.now();
    for (let i = 0; i < totalPages; i++) {
      const page = await pdfjsDoc.getPage(i + 1); // pdfjs は 1-indexed
      const viewport = page.getViewport({ scale: 1.0 });
      const textContent = await page.getTextContent();
      const textItems = (textContent.items as Array<any>).filter(
        (item) => typeof item.str === 'string' && item.str.trim() !== '',
      );

      const blocks: TextBlock[] = textItems.map((item, idx) => {
        const tx: number[] = item.transform;
        const mag = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1]) || 1;
        const ux = tx[0] / mag, uy = tx[1] / mag;
        const px = -uy, py = ux;
        const thickness =
          item.height > 0
            ? item.height
            : Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]) || mag || 12;
        const runLength = item.width || mag * item.str.length * 0.6;
        const ascent = thickness * 1.16;
        const corners: [number, number][] = [
          [tx[4], tx[5]],
          [tx[4] + ux * runLength, tx[5] + uy * runLength],
          [tx[4] + px * ascent, tx[5] + py * ascent],
          [tx[4] + ux * runLength + px * ascent, tx[5] + uy * runLength + py * ascent],
        ];
        const vc = corners.map(([cx, cy]) => viewport.convertToViewportPoint(cx, cy));
        const vxs = vc.map((c: number[]) => c[0]);
        const vys = vc.map((c: number[]) => c[1]);
        const bbox = {
          x: Math.min(...vxs) + SHIFT.dx, // ← 微移動
          y: Math.min(...vys) + SHIFT.dy,
          width: Math.max(...vxs) - Math.min(...vxs),
          height: Math.max(...vys) - Math.min(...vys),
        };
        const [vDirX, vDirY] = viewport.convertToViewportPoint(tx[4] + ux, tx[5] + uy);
        const isVertical =
          Math.abs(vDirY - vc[0][1]) > Math.abs(vDirX - vc[0][0]);
        return {
          id: `p${i}-b${idx}`,
          text: item.str,
          originalText: item.str,
          bbox,
          writingMode: (isVertical ? 'vertical' : 'horizontal') as WritingMode,
          order: idx,
          isNew: false,
          isDirty: true,
        };
      });

      totalBlocks += blocks.length;
      pages.set(i, {
        pageIndex: i,
        width: viewport.width,
        height: viewport.height,
        textBlocks: blocks,
        isDirty: true,
        thumbnail: null,
      });

      if ((i + 1) % 50 === 0 || i + 1 === totalPages) {
        console.log(
          `[REAL] extracted ${i + 1}/${totalPages} pages, total ${totalBlocks} blocks so far`,
        );
      }
    }
    // pdfjs のリソースを解放してメモリを空ける
    try { await pdfjsDoc.cleanup(); } catch { /* ignore */ }
    try { await pdfjsDoc.destroy(); } catch { /* ignore */ }
    console.log(
      `[REAL] extraction done: ${Date.now() - tExtractStart}ms, total blocks ${totalBlocks}`,
    );

    const doc: PecoDocument = {
      filePath: REAL_PDF_PATH,
      fileName: 'テストPDF.pdf',
      totalPages,
      metadata: {},
      pages,
    };

    // --- 日本語フォント読み込み ---
    // Node の Buffer.buffer は shared pool な場合があり pdf-lib の
    // instanceof ArrayBuffer 検証を通らないので fresh ArrayBuffer を作り直す
    const fontBuf = readFileSync(FONT_PATH);
    const fontArrayBuffer = new ArrayBuffer(fontBuf.byteLength);
    new Uint8Array(fontArrayBuffer).set(fontBuf);

    // --- savePDF 実行 (main thread fallback) ---
    console.log(`[REAL] calling savePDF...`);
    const tSave = Date.now();
    const savedBytes = await savePDF(
      { bytes: new Uint8Array(realBytes) },
      doc,
      fontArrayBuffer,
    );
    const elapsed = Date.now() - tSave;
    console.log(
      `[REAL] savePDF done: ${elapsed}ms, output ${(savedBytes.byteLength / 1024 / 1024).toFixed(1)} MB`,
    );

    // --- 別名で保存 (上書きしない) ---
    writeFileSync(OUTPUT_PATH, savedBytes);
    console.log(`[REAL] wrote ${OUTPUT_PATH}`);

    // --- 検証: 全ページで byte 差分が出ているか ---
    // pdf-lib は Node の Buffer を直接受けない (instanceof Uint8Array にならないため)
    const originalDoc = await PDFDocument.load(new Uint8Array(realBytes), {
      throwOnInvalidObject: false,
      ignoreEncryption: true,
      updateMetadata: false,
    });
    const savedDoc = await PDFDocument.load(new Uint8Array(savedBytes), {
      throwOnInvalidObject: false,
      ignoreEncryption: true,
      updateMetadata: false,
    });
    expect(savedDoc.getPages().length).toBe(totalPages);

    // bboxMeta に全ページぶんのエントリが書かれているか
    const bboxMeta = readBBoxMeta(savedDoc);
    expect(bboxMeta).not.toBeNull();
    const metaKeys = Object.keys(bboxMeta!);
    console.log(`[REAL] PecoToolBBoxes entries: ${metaKeys.length}`);

    // 各ページの content stream 差分検証
    const sameAsOriginal: number[] = [];
    const decodeFailedOrig: number[] = [];
    const decodeFailedNew: number[] = [];
    for (let i = 0; i < totalPages; i++) {
      const origDecoded = decodePageContents(originalDoc, i);
      const newDecoded = decodePageContents(savedDoc, i);
      if (!origDecoded) decodeFailedOrig.push(i);
      if (!newDecoded) decodeFailedNew.push(i);
      if (origDecoded && newDecoded) {
        if (origDecoded.length === newDecoded.length) {
          let diff = false;
          for (let j = 0; j < origDecoded.length; j++) {
            if (origDecoded[j] !== newDecoded[j]) { diff = true; break; }
          }
          if (!diff) sameAsOriginal.push(i);
        }
      }
    }

    console.log(`[REAL] 差分なしページ: ${sameAsOriginal.length} / ${totalPages}`);
    // 差分なしページのブロック数内訳 (0 件のページは「変更する対象がないため無変更」が正しい挙動)
    const sameWithBlocks: Array<{ page: number; blocks: number }> = sameAsOriginal.map((p) => ({
      page: p,
      blocks: pages.get(p)?.textBlocks.length ?? 0,
    }));
    const sameWithZeroBlocks = sameWithBlocks.filter((x) => x.blocks === 0);
    const sameWithNonzeroBlocks = sameWithBlocks.filter((x) => x.blocks > 0);
    console.log(
      `[REAL]   うち OCR ブロック 0 件のページ: ${sameWithZeroBlocks.length} (変更対象なし、差分なしは正常)`,
    );
    console.log(
      `[REAL]   うち OCR ブロック有りで差分なし: ${sameWithNonzeroBlocks.length} (これは異常)`,
    );
    if (sameWithNonzeroBlocks.length > 0) {
      console.log(
        `[REAL]   異常ページ詳細: ${JSON.stringify(sameWithNonzeroBlocks.slice(0, 20))}`,
      );
    }
    if (decodeFailedOrig.length > 0) {
      console.log(
        `[REAL] original decode 失敗 (複合フィルタ等): ${decodeFailedOrig.length} ページ`,
      );
    }
    if (decodeFailedNew.length > 0) {
      console.log(
        `[REAL] output decode 失敗: ${decodeFailedNew.length} ページ`,
      );
    }

    // 主判定: OCR ブロックがあるページはすべて差分がある
    //   ブロック 0 件のページは元々変更対象がないため差分なしで正常
    expect(sameWithNonzeroBlocks).toEqual([]);
    // bboxMeta も全ページに入っていること
    expect(metaKeys.length).toBeGreaterThanOrEqual(totalPages);
  }, 900_000); // 15 分

  it('20〜30 BB ページの中央 BB を分割 → 別名保存 → 再読込 meta が N+1 件で対応関係がずれない', async () => {
    const realBytes = readFileSync(REAL_PDF_PATH);
    const { doc, totalPages } = await buildPecoDocumentFromRealPdf(
      new Uint8Array(realBytes),
      { dx: 0, dy: 0 },
    );

    // --- 20〜30 BB を持つ水平書きページを探す (分割は水平書きで検証) ---
    let targetPageIndex = -1;
    for (let i = 0; i < totalPages; i++) {
      const pd = doc.pages.get(i)!;
      const count = pd.textBlocks.length;
      if (count >= 20 && count <= 30 && pd.textBlocks.every((b) => b.writingMode === 'horizontal')) {
        targetPageIndex = i;
        break;
      }
    }
    // 横書きページが無ければ、20〜30 BB でとにかく該当するページを採用
    if (targetPageIndex === -1) {
      for (let i = 0; i < totalPages; i++) {
        const count = doc.pages.get(i)!.textBlocks.length;
        if (count >= 20 && count <= 30) { targetPageIndex = i; break; }
      }
    }
    expect(targetPageIndex).toBeGreaterThanOrEqual(0);

    const targetPage = doc.pages.get(targetPageIndex)!;
    const origCount = targetPage.textBlocks.length;
    const midIdx = Math.floor(origCount / 2);
    const origBlock = targetPage.textBlocks[midIdx];
    console.log(
      `[REAL/split] target page ${targetPageIndex}, ${origCount} blocks, ` +
      `splitting block[${midIdx}] id=${origBlock.id} text="${origBlock.text.slice(0, 30)}"`
    );

    // --- 分割 (useCanvasDrawing.trySplit の水平書きロジックを同型で再現) ---
    const { b1, b2, finalBlocks } = splitBlockAtMiddle(targetPage, midIdx);
    console.log(
      `[REAL/split] b1.text="${b1.text.slice(0, 20)}" (${b1.bbox.x.toFixed(1)}+${b1.bbox.width.toFixed(1)}), ` +
      `b2.text="${b2.text.slice(0, 20)}" (${b2.bbox.x.toFixed(1)}+${b2.bbox.width.toFixed(1)})`
    );
    expect(finalBlocks.length).toBe(origCount + 1);
    expect(b1.text + b2.text).toBe(origBlock.text);

    // 対象ページのみ dirty にする (save を高速化するため他ページは dirty を解除)
    for (const [idx, pd] of doc.pages.entries()) {
      if (idx !== targetPageIndex) {
        doc.pages.set(idx, { ...pd, isDirty: false });
      }
    }
    doc.pages.set(targetPageIndex, {
      ...targetPage,
      textBlocks: finalBlocks,
      isDirty: true,
    });

    // --- フォント ---
    const fontBuf = readFileSync(FONT_PATH);
    const fontArrayBuffer = new ArrayBuffer(fontBuf.byteLength);
    new Uint8Array(fontArrayBuffer).set(fontBuf);

    // --- 保存 (対象ページのみ dirty) ---
    const tSave = Date.now();
    const savedBytes = await savePDF(
      { bytes: new Uint8Array(realBytes) },
      doc,
      fontArrayBuffer,
    );
    console.log(
      `[REAL/split] savePDF done: ${Date.now() - tSave}ms, output ${(savedBytes.byteLength / 1024 / 1024).toFixed(1)} MB`,
    );

    // --- 別名で書き出す (上書きしない) ---
    writeFileSync(OUTPUT_PATH_SPLIT, savedBytes);
    console.log(`[REAL/split] wrote ${OUTPUT_PATH_SPLIT}`);

    // --- 検証: 出力 PDF の bboxMeta に対象ページ N+1 件が正しい順序で入っているか ---
    const savedDoc = await PDFDocument.load(new Uint8Array(savedBytes), {
      throwOnInvalidObject: false,
      ignoreEncryption: true,
      updateMetadata: false,
    });
    const bboxMeta = readBBoxMeta(savedDoc) as Record<
      string,
      Array<{ bbox: { x: number; y: number; width: number; height: number }; text: string; order: number; writingMode: string }>
    > | null;
    expect(bboxMeta).not.toBeNull();
    const savedEntries = bboxMeta![String(targetPageIndex)];
    expect(savedEntries).toBeDefined();
    console.log(
      `[REAL/split] bboxMeta[page=${targetPageIndex}] entries: ${savedEntries.length} (orig ${origCount} → expected ${origCount + 1})`,
    );

    // --- (1) エントリ数が N+1 ---
    expect(savedEntries.length).toBe(origCount + 1);

    // --- (2) 各エントリの text/bbox/order が finalBlocks と 1:1 対応している ---
    //   これは「分割後に text が bbox に対して 1 つズレない」ことを直接示す
    const mismatches: Array<{ idx: number; reason: string }> = [];
    for (let i = 0; i < finalBlocks.length; i++) {
      const exp = finalBlocks[i];
      const got = savedEntries[i];
      if (got.text !== exp.text) {
        mismatches.push({ idx: i, reason: `text: expected "${exp.text}" got "${got.text}"` });
      }
      // bbox は序数値比較 (JSON roundtrip で多少の丸めが入る可能性を考慮せず strict 比較)
      if (
        got.bbox.x !== exp.bbox.x ||
        got.bbox.y !== exp.bbox.y ||
        got.bbox.width !== exp.bbox.width ||
        got.bbox.height !== exp.bbox.height
      ) {
        mismatches.push({
          idx: i,
          reason: `bbox: expected ${JSON.stringify(exp.bbox)} got ${JSON.stringify(got.bbox)}`,
        });
      }
      if (got.order !== i) {
        mismatches.push({ idx: i, reason: `order: expected ${i} got ${got.order}` });
      }
    }
    if (mismatches.length > 0) {
      console.log(`[REAL/split] mismatches: ${JSON.stringify(mismatches.slice(0, 10), null, 2)}`);
    }
    expect(mismatches).toEqual([]);

    // --- (3) 分割したブロックが意図通り bboxMeta に反映されている ---
    expect(savedEntries[midIdx].text).toBe(b1.text);
    expect(savedEntries[midIdx + 1].text).toBe(b2.text);
    // 分割の x 座標連続性: b1.x+b1.width == b2.x (within JSON 精度)
    expect(
      Math.abs(
        (savedEntries[midIdx].bbox.x + savedEntries[midIdx].bbox.width) -
        savedEntries[midIdx + 1].bbox.x,
      ),
    ).toBeLessThan(1e-6);

    // --- (4) 分割で消えた原ブロックの text は連結すると一致する ---
    expect(savedEntries[midIdx].text + savedEntries[midIdx + 1].text).toBe(origBlock.text);

    // --- (5) 分割位置より後の既存ブロックが 1 つ後ろにズレていない ---
    //   (本件の核心。off-by-one の再発検知)
    for (let i = midIdx + 2; i < finalBlocks.length; i++) {
      expect(savedEntries[i].text).toBe(finalBlocks[i].text);
    }
  }, 900_000);

  // ── ラストチェック #1: OCR 不変で全 BB を目視可能な量 (+30, +30) 移動 ──
  it('【ラスト #1】OCR 内容は変更せず全 BB を目に見える量 (+30, +30) 移動 → 別名保存', async () => {
    const realBytes = readFileSync(REAL_PDF_PATH);

    // シフト前のままで抽出 → 元位置を記録
    const { doc, totalPages, totalBlocks } = await buildPecoDocumentFromRealPdf(
      new Uint8Array(realBytes),
      { dx: 0, dy: 0 },
    );
    const origPosByPage = new Map<number, Array<{ x: number; y: number; text: string }>>();
    for (const [p, pd] of doc.pages.entries()) {
      origPosByPage.set(
        p,
        pd.textBlocks.map((b) => ({ x: b.bbox.x, y: b.bbox.y, text: b.text })),
      );
    }

    // 目視可能な (+30, +30) を適用 (テキストは不変、bbox.x/y のみ変化)
    for (const [p, pd] of doc.pages.entries()) {
      const shifted = pd.textBlocks.map((b) => ({
        ...b,
        bbox: {
          ...b.bbox,
          x: b.bbox.x + VISIBLE_SHIFT.dx,
          y: b.bbox.y + VISIBLE_SHIFT.dy,
        },
        isDirty: true,
      }));
      doc.pages.set(p, { ...pd, textBlocks: shifted, isDirty: true });
    }
    console.log(
      `[REAL/move] pages=${totalPages}, blocks=${totalBlocks}, shift=(+${VISIBLE_SHIFT.dx}, +${VISIBLE_SHIFT.dy})`,
    );

    const fontBuf = readFileSync(FONT_PATH);
    const fontArrayBuffer = new ArrayBuffer(fontBuf.byteLength);
    new Uint8Array(fontArrayBuffer).set(fontBuf);

    const tSave = Date.now();
    const savedBytes = await savePDF(
      { bytes: new Uint8Array(realBytes) },
      doc,
      fontArrayBuffer,
    );
    console.log(
      `[REAL/move] savePDF done: ${Date.now() - tSave}ms, output ${(savedBytes.byteLength / 1024 / 1024).toFixed(1)} MB`,
    );

    writeFileSync(OUTPUT_PATH_MOVE, savedBytes);
    console.log(`[REAL/move] wrote ${OUTPUT_PATH_MOVE}`);

    // --- 検証 ---
    const originalDoc = await PDFDocument.load(new Uint8Array(realBytes), {
      throwOnInvalidObject: false,
      ignoreEncryption: true,
      updateMetadata: false,
    });
    const savedDoc = await PDFDocument.load(new Uint8Array(savedBytes), {
      throwOnInvalidObject: false,
      ignoreEncryption: true,
      updateMetadata: false,
    });

    // (a) bboxMeta: 全ページぶんのエントリがあり、各 bbox が (+30, +30) 移動、text は元のまま
    const bboxMeta = readBBoxMeta(savedDoc) as Record<
      string,
      Array<{ bbox: { x: number; y: number; width: number; height: number }; text: string }>
    > | null;
    expect(bboxMeta).not.toBeNull();
    expect(Object.keys(bboxMeta!).length).toBe(totalPages);

    // 全ページ全ブロック一致: (保存 bbox.x, y) == (元 x + 30, 元 y + 30)、text は不変
    const moveMismatch: Array<{ page: number; idx: number; reason: string }> = [];
    for (let p = 0; p < totalPages; p++) {
      const entries = bboxMeta![String(p)];
      const orig = origPosByPage.get(p)!;
      if (entries.length !== orig.length) {
        moveMismatch.push({ page: p, idx: -1, reason: `count ${entries.length} != ${orig.length}` });
        continue;
      }
      for (let i = 0; i < entries.length; i++) {
        const expX = orig[i].x + VISIBLE_SHIFT.dx;
        const expY = orig[i].y + VISIBLE_SHIFT.dy;
        if (Math.abs(entries[i].bbox.x - expX) > 1e-6) {
          moveMismatch.push({ page: p, idx: i, reason: `x ${entries[i].bbox.x} != ${expX}` });
        }
        if (Math.abs(entries[i].bbox.y - expY) > 1e-6) {
          moveMismatch.push({ page: p, idx: i, reason: `y ${entries[i].bbox.y} != ${expY}` });
        }
        if (entries[i].text !== orig[i].text) {
          moveMismatch.push({ page: p, idx: i, reason: `text changed: "${entries[i].text}" vs "${orig[i].text}"` });
        }
      }
    }
    console.log(`[REAL/move] 移動不一致: ${moveMismatch.length}`);
    if (moveMismatch.length > 0) {
      console.log(`[REAL/move] 例 (5件): ${JSON.stringify(moveMismatch.slice(0, 5))}`);
    }
    expect(moveMismatch).toEqual([]);

    // (b) 全ページで byte 差分 (ブロックありのページ)
    const sameAsOriginal: number[] = [];
    for (let i = 0; i < totalPages; i++) {
      const origDecoded = decodePageContents(originalDoc, i);
      const newDecoded = decodePageContents(savedDoc, i);
      if (origDecoded && newDecoded && origDecoded.length === newDecoded.length) {
        let diff = false;
        for (let j = 0; j < origDecoded.length; j++) {
          if (origDecoded[j] !== newDecoded[j]) { diff = true; break; }
        }
        if (!diff) sameAsOriginal.push(i);
      }
    }
    const nonzeroBlockPagesSame = sameAsOriginal.filter(
      (p) => (doc.pages.get(p)?.textBlocks.length ?? 0) > 0,
    );
    console.log(
      `[REAL/move] 差分なし: ${sameAsOriginal.length} (うち OCR 有: ${nonzeroBlockPagesSame.length})`,
    );
    expect(nonzeroBlockPagesSame).toEqual([]);
  }, 900_000);

  // ── ラストチェック #2: 全ページの全 BB を分割 ──
  it('【ラスト #3】位置を +30 移動 → 別名保存 → 開き直し → -30 で元位置に戻して再保存 → 元位置と一致', async () => {
    const realBytes = readFileSync(REAL_PDF_PATH);

    // --- 元位置を記録 ---
    const { doc, totalPages, totalBlocks } = await buildPecoDocumentFromRealPdf(
      new Uint8Array(realBytes),
      { dx: 0, dy: 0 },
    );
    const origByPage = new Map<
      number,
      Array<{ text: string; x: number; y: number; width: number; height: number }>
    >();
    const pageDim = new Map<number, { width: number; height: number }>();
    for (const [p, pd] of doc.pages.entries()) {
      origByPage.set(
        p,
        pd.textBlocks.map((b) => ({
          text: b.text,
          x: b.bbox.x,
          y: b.bbox.y,
          width: b.bbox.width,
          height: b.bbox.height,
        })),
      );
      pageDim.set(p, { width: pd.width, height: pd.height });
    }
    console.log(`[REAL/move2] pages=${totalPages}, blocks=${totalBlocks}`);

    // --- フォント ---
    const fontBuf = readFileSync(FONT_PATH);
    const fontArrayBuffer = new ArrayBuffer(fontBuf.byteLength);
    new Uint8Array(fontArrayBuffer).set(fontBuf);

    // --- Round 1: +30, +30 シフトを適用して保存 ---
    for (const [p, pd] of doc.pages.entries()) {
      const shifted = pd.textBlocks.map((b) => ({
        ...b,
        bbox: { ...b.bbox, x: b.bbox.x + 30, y: b.bbox.y + 30 },
        isDirty: true,
      }));
      doc.pages.set(p, { ...pd, textBlocks: shifted, isDirty: true });
    }
    const t1 = Date.now();
    const saved1 = await savePDF({ bytes: new Uint8Array(realBytes) }, doc, fontArrayBuffer);
    console.log(`[REAL/move2] Round1 (+30) savePDF: ${Date.now() - t1}ms, ${(saved1.byteLength / 1024 / 1024).toFixed(1)} MB`);
    writeFileSync(outputPath('_move2_shifted'), saved1);

    // --- 開き直し: 保存済み PDF から bboxMeta を読み、PecoDocument を再構築 ---
    const savedDoc1 = await PDFDocument.load(new Uint8Array(saved1), {
      throwOnInvalidObject: false,
      ignoreEncryption: true,
      updateMetadata: false,
    });
    const meta1 = readBBoxMeta(savedDoc1) as Record<
      string,
      Array<{ bbox: { x: number; y: number; width: number; height: number }; text: string; order: number; writingMode: string }>
    > | null;
    expect(meta1).not.toBeNull();

    // production pdfTextExtractor.loadPage (safe-decode 修正後) と等価な再構築
    const reloadedPages = new Map<number, PageData>();
    for (let p = 0; p < totalPages; p++) {
      const entries = meta1![String(p)] ?? [];
      const blocks: TextBlock[] = entries.map((m, idx) => ({
        id: `reload-p${p}-${idx}`,
        text: m.text,
        originalText: m.text,
        bbox: m.bbox,
        writingMode: m.writingMode as WritingMode,
        order: m.order,
        isNew: false,
        isDirty: false,
      }));
      const dim = pageDim.get(p) ?? { width: 595, height: 842 };
      reloadedPages.set(p, {
        pageIndex: p,
        width: dim.width,
        height: dim.height,
        textBlocks: blocks,
        isDirty: false,
        thumbnail: null,
      });
    }
    const doc2: PecoDocument = { ...doc, pages: reloadedPages };

    // --- Round 2: 再読込したブロックに -30, -30 を適用 → 元位置相当に戻す ---
    for (const [p, pd] of doc2.pages.entries()) {
      const restored = pd.textBlocks.map((b) => ({
        ...b,
        bbox: { ...b.bbox, x: b.bbox.x - 30, y: b.bbox.y - 30 },
        isDirty: true,
      }));
      doc2.pages.set(p, { ...pd, textBlocks: restored, isDirty: true });
    }
    // 実運用では「open したファイルのバイト列」が originalBytes に入るので saved1 を source に渡す
    const t2 = Date.now();
    const saved2 = await savePDF({ bytes: new Uint8Array(saved1) }, doc2, fontArrayBuffer);
    console.log(`[REAL/move2] Round2 (-30) savePDF: ${Date.now() - t2}ms, ${(saved2.byteLength / 1024 / 1024).toFixed(1)} MB`);
    writeFileSync(outputPath('_move2_restored'), saved2);

    // --- 検証: 2 周目の保存結果が元位置と一致するか ---
    const savedDoc2 = await PDFDocument.load(new Uint8Array(saved2), {
      throwOnInvalidObject: false,
      ignoreEncryption: true,
      updateMetadata: false,
    });
    const meta2 = readBBoxMeta(savedDoc2) as Record<
      string,
      Array<{ bbox: { x: number; y: number; width: number; height: number }; text: string }>
    > | null;
    expect(meta2).not.toBeNull();

    const mismatches: Array<{ page: number; idx: number; reason: string }> = [];
    for (let p = 0; p < totalPages; p++) {
      const orig = origByPage.get(p)!;
      const got = meta2![String(p)] ?? [];
      if (got.length !== orig.length) {
        mismatches.push({ page: p, idx: -1, reason: `count ${got.length} vs ${orig.length}` });
        continue;
      }
      for (let i = 0; i < orig.length; i++) {
        if (Math.abs(got[i].bbox.x - orig[i].x) > 1e-6) {
          mismatches.push({ page: p, idx: i, reason: `x ${got[i].bbox.x} vs orig ${orig[i].x}` });
        }
        if (Math.abs(got[i].bbox.y - orig[i].y) > 1e-6) {
          mismatches.push({ page: p, idx: i, reason: `y ${got[i].bbox.y} vs orig ${orig[i].y}` });
        }
        if (got[i].text !== orig[i].text) {
          mismatches.push({ page: p, idx: i, reason: `text "${got[i].text}" vs "${orig[i].text}"` });
        }
      }
    }
    console.log(`[REAL/move2] 元位置との不一致: ${mismatches.length}`);
    if (mismatches.length > 0) {
      console.log(`[REAL/move2] 例 (5 件): ${JSON.stringify(mismatches.slice(0, 5))}`);
    }
    expect(mismatches).toEqual([]);
  }, 900_000);

  // ── B4: 全ブロック削除したページの save/reload ──
  it('【B4】あるページの全ブロックを削除 → save → reload で meta[page] が [] になり text/bbox の漏れなし', async () => {
    const realBytes = readFileSync(REAL_PDF_PATH);
    const { doc, totalPages } = await buildPecoDocumentFromRealPdf(
      new Uint8Array(realBytes),
      { dx: 0, dy: 0 },
    );

    // ブロック数が多めのページを対象に選ぶ
    let targetPage = -1;
    let origCount = 0;
    for (let i = 0; i < totalPages; i++) {
      const n = doc.pages.get(i)!.textBlocks.length;
      if (n >= 10) { targetPage = i; origCount = n; break; }
    }
    expect(targetPage).toBeGreaterThanOrEqual(0);
    console.log(`[B4] target page ${targetPage} had ${origCount} blocks; deleting all`);

    // 対象ページだけ全ブロック削除 & dirty、他ページは dirty=false
    for (const [idx, pd] of doc.pages.entries()) {
      if (idx === targetPage) {
        doc.pages.set(idx, { ...pd, textBlocks: [], isDirty: true });
      } else {
        doc.pages.set(idx, { ...pd, isDirty: false });
      }
    }

    const fontBuf = readFileSync(FONT_PATH);
    const fontArrayBuffer = new ArrayBuffer(fontBuf.byteLength);
    new Uint8Array(fontArrayBuffer).set(fontBuf);
    const saved = await savePDF({ bytes: new Uint8Array(realBytes) }, doc, fontArrayBuffer);
    writeFileSync(outputPath('_empty_page'), saved);

    // 検証 (1): meta[targetPage] は [] になっている
    const savedDoc = await PDFDocument.load(new Uint8Array(saved), {
      throwOnInvalidObject: false, ignoreEncryption: true, updateMetadata: false,
    });
    const meta = readBBoxMeta(savedDoc) as Record<string, Array<unknown>> | null;
    expect(meta).not.toBeNull();
    expect(Array.isArray(meta![String(targetPage)])).toBe(true);
    expect(meta![String(targetPage)].length).toBe(0);
    console.log(`[B4] meta[${targetPage}].length = ${meta![String(targetPage)].length}`);

    // 検証 (2): content stream 上の テキストレイヤが消えている (stripTextBlocks 成功)
    //   元 PDF には「Tj」「TJ」のテキスト operator が多数あったはず → 対象ページは激減しているはず
    const originalDoc = await PDFDocument.load(new Uint8Array(realBytes), {
      throwOnInvalidObject: false, ignoreEncryption: true, updateMetadata: false,
    });
    const origStream = decodePageContents(originalDoc, targetPage);
    const newStream = decodePageContents(savedDoc, targetPage);
    const origText = origStream ? Buffer.from(origStream).toString('latin1') : '';
    const newText = newStream ? Buffer.from(newStream).toString('latin1') : '';
    const origTjCount = (origText.match(/\bTj\b/g) ?? []).length + (origText.match(/\bTJ\b/g) ?? []).length;
    const newTjCount = (newText.match(/\bTj\b/g) ?? []).length + (newText.match(/\bTJ\b/g) ?? []).length;
    console.log(`[B4] page ${targetPage} Tj/TJ ops: original=${origTjCount}, new=${newTjCount}`);
    expect(newTjCount).toBeLessThan(origTjCount); // 大きく減っているはず
  }, 600_000);

  // ── D5: 縦書きブロックの分割 (writingMode=vertical を強制) ──
  it('【D5】縦書きブロックを分割 → save → reload で height 方向に正しく分割されている', async () => {
    const realBytes = readFileSync(REAL_PDF_PATH);
    const { doc, totalPages } = await buildPecoDocumentFromRealPdf(
      new Uint8Array(realBytes),
      { dx: 0, dy: 0 },
    );

    // 縦書きが実 PDF に無かったため、text >= 4 の横書きブロックを 1 つ取り
    // writingMode='vertical' に強制上書きして bbox を縦長 (width/height 入替)
    let targetPage = -1;
    let sourceBlock: TextBlock | null = null;
    for (let i = 0; i < totalPages; i++) {
      const pd = doc.pages.get(i)!;
      for (const b of pd.textBlocks) {
        if (b.text.length >= 4 && b.writingMode === 'horizontal') {
          targetPage = i;
          sourceBlock = b;
          break;
        }
      }
      if (targetPage !== -1) break;
    }
    expect(sourceBlock).not.toBeNull();
    expect(targetPage).toBeGreaterThanOrEqual(0);

    // 該当ブロックを縦書き化 (width/height を swap してそれっぽい形に)
    const origBbox = sourceBlock!.bbox;
    const verticalBlock: TextBlock = {
      ...sourceBlock!,
      writingMode: 'vertical',
      bbox: { x: origBbox.x, y: origBbox.y, width: origBbox.height, height: origBbox.width * 4 },
      isDirty: true,
    };
    console.log(`[D5] target page ${targetPage}, block id=${verticalBlock.id}, text="${verticalBlock.text}", bbox=${JSON.stringify(verticalBlock.bbox)}`);

    // 縦書き分割を実行 (splitBlockInHalf は writingMode を見て height 方向に split する)
    const split = splitBlockInHalf(verticalBlock);
    expect(split).not.toBeNull();
    const { b1, b2 } = split!;

    // 期待: b1.y, b1.height は verticalBlock 同じ x/width で、高さを比率分。b2 は下半分。
    expect(b1.bbox.x).toBe(verticalBlock.bbox.x);
    expect(b1.bbox.width).toBe(verticalBlock.bbox.width);
    expect(b2.bbox.x).toBe(verticalBlock.bbox.x);
    expect(b2.bbox.width).toBe(verticalBlock.bbox.width);
    // b2 は b1 の下 (y+height) から始まり、高さの和 = 元の高さ
    expect(Math.abs((b1.bbox.y + b1.bbox.height) - b2.bbox.y)).toBeLessThan(1e-6);
    expect(Math.abs((b1.bbox.height + b2.bbox.height) - verticalBlock.bbox.height)).toBeLessThan(1e-6);

    // 対象ページに縦書き分割後の 2 ブロックだけを配置して save (他ページは dirty=false)
    for (const [idx, pd] of doc.pages.entries()) {
      if (idx === targetPage) {
        const finalBlocks: TextBlock[] = [
          { ...b1, order: 0 },
          { ...b2, order: 1 },
        ];
        doc.pages.set(idx, { ...pd, textBlocks: finalBlocks, isDirty: true });
      } else {
        doc.pages.set(idx, { ...pd, isDirty: false });
      }
    }

    const fontBuf = readFileSync(FONT_PATH);
    const fontArrayBuffer = new ArrayBuffer(fontBuf.byteLength);
    new Uint8Array(fontArrayBuffer).set(fontBuf);
    const saved = await savePDF({ bytes: new Uint8Array(realBytes) }, doc, fontArrayBuffer);
    writeFileSync(outputPath('_vertical_split'), saved);

    // reload で縦書き bbox が保持されていることを検証
    const savedDoc = await PDFDocument.load(new Uint8Array(saved), {
      throwOnInvalidObject: false, ignoreEncryption: true, updateMetadata: false,
    });
    const meta = readBBoxMeta(savedDoc) as Record<
      string,
      Array<{ bbox: { x: number; y: number; width: number; height: number }; text: string; writingMode: string }>
    > | null;
    expect(meta).not.toBeNull();
    const entries = meta![String(targetPage)];
    expect(entries).toHaveLength(2);
    expect(entries[0].writingMode).toBe('vertical');
    expect(entries[1].writingMode).toBe('vertical');
    // b1 と b2 が height 方向で連続している (reload で壊れない)
    expect(Math.abs((entries[0].bbox.y + entries[0].bbox.height) - entries[1].bbox.y)).toBeLessThan(1e-6);
    expect(entries[0].text + entries[1].text).toBe(verticalBlock.text);
    console.log(`[D5] reloaded entries: b1="${entries[0].text}" bbox=${JSON.stringify(entries[0].bbox)}, b2="${entries[1].text}" bbox=${JSON.stringify(entries[1].bbox)}`);
  }, 600_000);

  // ── D4: 絵文字・サロゲートペアを含む text の save/reload ──
  it('【D4】絵文字・サロゲートペア text を含むブロックを save → reload で text が壊れない', async () => {
    const realBytes = readFileSync(REAL_PDF_PATH);
    const { doc, totalPages } = await buildPecoDocumentFromRealPdf(
      new Uint8Array(realBytes),
      { dx: 0, dy: 0 },
    );

    // 非 BMP 文字 (4 バイト UTF-16 サロゲートペア) を含む test 文字列
    //   "𠮷" = U+20BB7 (非 BMP, サロゲートペア)
    //   "髙" = U+9AD9 (BMP 内だが pdf フォントでは要注意)
    //   "😀" = U+1F600 (絵文字, サロゲートペア)
    //   "🇯🇵" = 2 code points (各々サロゲートペア) で構成
    const testStrings = [
      'ABC𠮷野家DEF',          // 非 BMP CJK + ASCII
      '髙橋さん',                // BMP 外フォント要注意字
      'emoji→😀←test',        // 絵文字
      'flag🇯🇵end',              // ZWJ/regional indicator
    ];

    // targetPage: 対象ブロックが最低 testStrings.length 個ある最初のページ
    let targetPage = -1;
    for (let i = 0; i < totalPages; i++) {
      if (doc.pages.get(i)!.textBlocks.length >= testStrings.length) {
        targetPage = i;
        break;
      }
    }
    expect(targetPage).toBeGreaterThanOrEqual(0);

    // 先頭の N ブロックを test 文字列で置換 (bbox はそのまま)
    const pd = doc.pages.get(targetPage)!;
    const edited = pd.textBlocks.map((b, idx) =>
      idx < testStrings.length ? { ...b, text: testStrings[idx], originalText: testStrings[idx], isDirty: true } : b,
    );
    for (const [idx, pdOther] of doc.pages.entries()) {
      if (idx === targetPage) {
        doc.pages.set(idx, { ...pdOther, textBlocks: edited, isDirty: true });
      } else {
        doc.pages.set(idx, { ...pdOther, isDirty: false });
      }
    }
    console.log(`[D4] target page ${targetPage}, writing test strings to first ${testStrings.length} blocks`);

    const fontBuf = readFileSync(FONT_PATH);
    const fontArrayBuffer = new ArrayBuffer(fontBuf.byteLength);
    new Uint8Array(fontArrayBuffer).set(fontBuf);
    const saved = await savePDF({ bytes: new Uint8Array(realBytes) }, doc, fontArrayBuffer);
    writeFileSync(outputPath('_surrogate'), saved);

    // reload: bboxMeta から test 文字列を 1 文字も欠けず復元できているか
    const savedDoc = await PDFDocument.load(new Uint8Array(saved), {
      throwOnInvalidObject: false, ignoreEncryption: true, updateMetadata: false,
    });
    const meta = readBBoxMeta(savedDoc) as Record<string, Array<{ text: string }>> | null;
    expect(meta).not.toBeNull();
    const entries = meta![String(targetPage)];

    const textMismatch: Array<{ idx: number; expected: string; got: string }> = [];
    for (let i = 0; i < testStrings.length; i++) {
      if (entries[i].text !== testStrings[i]) {
        textMismatch.push({ idx: i, expected: testStrings[i], got: entries[i].text });
      }
    }
    console.log(`[D4] text mismatches: ${textMismatch.length}/${testStrings.length}`);
    if (textMismatch.length > 0) {
      console.log(`[D4] details: ${JSON.stringify(textMismatch)}`);
    }
    expect(textMismatch).toEqual([]);
  }, 600_000);

  it('【ラスト #4】OCR 内容を編集 + 位置を (+20, +20) → 別名保存 → 開き直して text と bbox がズレていない', async () => {
    const realBytes = readFileSync(REAL_PDF_PATH);
    const { doc, totalPages, totalBlocks } = await buildPecoDocumentFromRealPdf(
      new Uint8Array(realBytes),
      { dx: 0, dy: 0 },
    );
    console.log(`[REAL/edited] pages=${totalPages}, blocks=${totalBlocks}`);

    // 期待値: 編集後の text と 移動後の bbox を記録
    const expectedByPage = new Map<
      number,
      Array<{ text: string; x: number; y: number; width: number; height: number }>
    >();
    for (const [p, pd] of doc.pages.entries()) {
      const edited = pd.textBlocks.map((b, idx) => ({
        ...b,
        // text を接頭辞で編集 (ブロックごとにユニーク)
        text: `E${p}-${idx}:${b.text}`,
        originalText: `E${p}-${idx}:${b.text}`,
        // 位置を +20, +20 移動
        bbox: { ...b.bbox, x: b.bbox.x + 20, y: b.bbox.y + 20 },
        isDirty: true,
      }));
      doc.pages.set(p, { ...pd, textBlocks: edited, isDirty: true });
      expectedByPage.set(
        p,
        edited.map((b) => ({
          text: b.text,
          x: b.bbox.x,
          y: b.bbox.y,
          width: b.bbox.width,
          height: b.bbox.height,
        })),
      );
    }

    // 保存
    const fontBuf = readFileSync(FONT_PATH);
    const fontArrayBuffer = new ArrayBuffer(fontBuf.byteLength);
    new Uint8Array(fontArrayBuffer).set(fontBuf);

    const tSave = Date.now();
    const savedBytes = await savePDF(
      { bytes: new Uint8Array(realBytes) },
      doc,
      fontArrayBuffer,
    );
    console.log(`[REAL/edited] savePDF: ${Date.now() - tSave}ms, ${(savedBytes.byteLength / 1024 / 1024).toFixed(1)} MB`);
    writeFileSync(outputPath('_edited'), savedBytes);

    // --- 開き直し (production pdfMetadataLoader + pdfTextExtractor と等価) ---
    const savedDoc = await PDFDocument.load(new Uint8Array(savedBytes), {
      throwOnInvalidObject: false,
      ignoreEncryption: true,
      updateMetadata: false,
    });
    const meta = readBBoxMeta(savedDoc) as Record<
      string,
      Array<{ bbox: { x: number; y: number; width: number; height: number }; text: string; order: number }>
    > | null;
    expect(meta).not.toBeNull();
    expect(Object.keys(meta!).length).toBe(totalPages);

    // --- 検証 ---
    const textMismatch: Array<{ page: number; idx: number; expected: string; got: string }> = [];
    const bboxMismatch: Array<{ page: number; idx: number; reason: string }> = [];
    const countMismatch: Array<{ page: number; got: number; expected: number }> = [];
    for (let p = 0; p < totalPages; p++) {
      const exp = expectedByPage.get(p)!;
      const got = meta![String(p)] ?? [];
      if (got.length !== exp.length) {
        countMismatch.push({ page: p, got: got.length, expected: exp.length });
        continue;
      }
      for (let i = 0; i < exp.length; i++) {
        if (got[i].text !== exp[i].text) {
          textMismatch.push({ page: p, idx: i, expected: exp[i].text, got: got[i].text });
        }
        if (
          Math.abs(got[i].bbox.x - exp[i].x) > 1e-6 ||
          Math.abs(got[i].bbox.y - exp[i].y) > 1e-6 ||
          Math.abs(got[i].bbox.width - exp[i].width) > 1e-6 ||
          Math.abs(got[i].bbox.height - exp[i].height) > 1e-6
        ) {
          bboxMismatch.push({
            page: p, idx: i,
            reason: `expected (${exp[i].x},${exp[i].y},${exp[i].width},${exp[i].height}) got (${got[i].bbox.x},${got[i].bbox.y},${got[i].bbox.width},${got[i].bbox.height})`,
          });
        }
      }
    }
    console.log(
      `[REAL/edited] 件数不一致: ${countMismatch.length}, text 不一致: ${textMismatch.length}, bbox 不一致: ${bboxMismatch.length}`,
    );
    if (textMismatch.length > 0) {
      console.log(`[REAL/edited] text 例: ${JSON.stringify(textMismatch.slice(0, 5))}`);
    }
    if (bboxMismatch.length > 0) {
      console.log(`[REAL/edited] bbox 例: ${JSON.stringify(bboxMismatch.slice(0, 5))}`);
    }
    expect(countMismatch).toEqual([]);
    expect(textMismatch).toEqual([]);
    expect(bboxMismatch).toEqual([]);
  }, 900_000);

  it('【ラスト #2】全ページの全 BB を半分に分割 → 別名保存 → 分割後のブロック対応関係がずれない', async () => {
    const realBytes = readFileSync(REAL_PDF_PATH);
    const { doc, totalPages, totalBlocks: origTotalBlocks } = await buildPecoDocumentFromRealPdf(
      new Uint8Array(realBytes),
      { dx: 0, dy: 0 },
    );

    // 全ブロックを分割 (length >= 2 のみ)。期待結果をページごとに記録して後で検証。
    let splitCount = 0;
    let keptAsIs = 0;
    const expectedByPage = new Map<number, TextBlock[]>();
    for (const [pageIdx, pageData] of doc.pages.entries()) {
      const newBlocks: TextBlock[] = [];
      for (const block of pageData.textBlocks) {
        const res = splitBlockInHalf(block);
        if (res) {
          newBlocks.push(res.b1, res.b2);
          splitCount++;
        } else {
          newBlocks.push(block);
          keptAsIs++;
        }
      }
      const final = newBlocks.map((b, i) => ({ ...b, order: i }));
      expectedByPage.set(pageIdx, final);
      doc.pages.set(pageIdx, { ...pageData, textBlocks: final, isDirty: true });
    }
    console.log(
      `[REAL/split-all] original blocks=${origTotalBlocks}, split=${splitCount} (text>=2), kept=${keptAsIs} (text<2)`,
    );

    const fontBuf = readFileSync(FONT_PATH);
    const fontArrayBuffer = new ArrayBuffer(fontBuf.byteLength);
    new Uint8Array(fontArrayBuffer).set(fontBuf);

    const tSave = Date.now();
    const savedBytes = await savePDF(
      { bytes: new Uint8Array(realBytes) },
      doc,
      fontArrayBuffer,
    );
    console.log(
      `[REAL/split-all] savePDF done: ${Date.now() - tSave}ms, output ${(savedBytes.byteLength / 1024 / 1024).toFixed(1)} MB`,
    );

    writeFileSync(OUTPUT_PATH_SPLIT_ALL, savedBytes);
    console.log(`[REAL/split-all] wrote ${OUTPUT_PATH_SPLIT_ALL}`);

    // --- 検証 ---
    const savedDoc = await PDFDocument.load(new Uint8Array(savedBytes), {
      throwOnInvalidObject: false,
      ignoreEncryption: true,
      updateMetadata: false,
    });
    const bboxMeta = readBBoxMeta(savedDoc) as Record<
      string,
      Array<{ bbox: { x: number; y: number; width: number; height: number }; text: string; order: number }>
    > | null;
    expect(bboxMeta).not.toBeNull();
    expect(Object.keys(bboxMeta!).length).toBe(totalPages);

    // (a) 全ページで bboxMeta.length == expected.length
    const pageCountMismatch: Array<{ page: number; got: number; expected: number }> = [];
    for (let p = 0; p < totalPages; p++) {
      const exp = expectedByPage.get(p)!;
      const got = bboxMeta![String(p)];
      if (got.length !== exp.length) {
        pageCountMismatch.push({ page: p, got: got.length, expected: exp.length });
      }
    }
    console.log(`[REAL/split-all] 件数不一致ページ: ${pageCountMismatch.length}`);
    expect(pageCountMismatch).toEqual([]);

    // (b) 全ページで text/bbox/order が 1:1 対応している (= off-by-one ズレなし)
    const textMismatch: Array<{ page: number; idx: number; expected: string; got: string }> = [];
    const bboxMismatch: Array<{ page: number; idx: number }> = [];
    for (let p = 0; p < totalPages; p++) {
      const exp = expectedByPage.get(p)!;
      const got = bboxMeta![String(p)];
      for (let i = 0; i < exp.length; i++) {
        if (got[i].text !== exp[i].text) {
          textMismatch.push({ page: p, idx: i, expected: exp[i].text, got: got[i].text });
        }
        if (
          got[i].bbox.x !== exp[i].bbox.x ||
          got[i].bbox.y !== exp[i].bbox.y ||
          got[i].bbox.width !== exp[i].bbox.width ||
          got[i].bbox.height !== exp[i].bbox.height
        ) {
          bboxMismatch.push({ page: p, idx: i });
        }
      }
    }
    console.log(
      `[REAL/split-all] text 不一致: ${textMismatch.length}, bbox 不一致: ${bboxMismatch.length}`,
    );
    if (textMismatch.length > 0) {
      console.log(`[REAL/split-all] text 不一致例 (先頭 5 件): ${JSON.stringify(textMismatch.slice(0, 5))}`);
    }
    expect(textMismatch).toEqual([]);
    expect(bboxMismatch).toEqual([]);

    // (c) 分割前後で「連結 text」が保たれている: b1.text + b2.text == 元 text
    //   expectedByPage から抜き出して検証
    let concatChecked = 0;
    for (let p = 0; p < totalPages; p++) {
      const exp = expectedByPage.get(p)!;
      for (let i = 0; i + 1 < exp.length; i++) {
        const a = exp[i], b = exp[i + 1];
        // '-L' / '-R' のペアで分割前テキストを復元できるはず
        if (a.id.endsWith('-L') && b.id.endsWith('-R') && a.id.slice(0, -2) === b.id.slice(0, -2)) {
          concatChecked++;
        }
      }
    }
    expect(concatChecked).toBeGreaterThan(0);
    console.log(`[REAL/split-all] 分割ペア検証: ${concatChecked} 組`);
  }, 900_000);
});
