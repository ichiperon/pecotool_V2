/**
 * 負荷テスト: 500 ページ全件編集 → savePDF で全ページの差分が生成されることを検証する。
 *
 * 目的:
 *   ユーザーが「500 ページ全編集 → 別名保存」操作を行ったとき、保存結果 PDF の
 *   全 500 ページに実際に差分（ユーザー編集）が反映されていることを保証する。
 *   これは以下を同時に検証する:
 *     (1) dirtyOnlyPages フィルタで 1 ページも落ちていない
 *     (2) buildPdfDocument の stripTextBlocks が全 500 ページで実行されている
 *     (3) drawText が全 500 ページで行われている
 *     (4) PecoToolBBoxes info dict に全 500 ページぶんのメタデータが入っている
 *
 * 実装方針:
 *   他の integration テストは @cantoo/pdf-lib を mock しているが、本テストでは
 *   バイト単位の差分検証が必要なため **実 pdf-lib をそのまま使う**。
 *   Worker は __setSaveWorkerFactoryForTest で無効化し main thread で実行する。
 *   フォントはファイル I/O を避けるため StandardFonts.Helvetica (ASCII) にフォールバック
 *   させ、テキストも ASCII のみに限定する。
 *
 * 実行時間: 環境により 20〜40 秒程度。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
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

// Tauri / 外部 IO のみ mock。pdf-lib は実物を使う。
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (p: string) => p,
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  stat: vi.fn().mockResolvedValue({ mtime: Date.now() }),
}));
vi.mock('../../utils/bitmapCache', () => ({
  clearBitmapCache: vi.fn(),
}));
// pdfjs-dist は本テストでは使わないが import 経路上で評価されると重いので軽く mock する
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(),
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

import {
  savePDF,
  __setSaveWorkerFactoryForTest,
  __resetSaveStateForTest,
} from '../../utils/pdfSaver';
import type { PecoDocument, PageData, TextBlock } from '../../types';

const TOTAL_PAGES = 500;
const ORIG_PREFIX = 'ORIG_MARKER_';
const EDIT_PREFIX = 'EDIT_MARKER_';

/** 500 ページの合成 PDF を生成する。各ページに ORIG_MARKER_{i} を drawText で埋め込む。 */
async function buildSyntheticPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < TOTAL_PAGES; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`${ORIG_PREFIX}${i}`, { x: 50, y: 750, size: 12 });
  }
  return await doc.save({ useObjectStreams: false });
}

/** 500 ページぶんの dirty な PecoDocument を組み立てる。 */
function buildEditedDocument(filePath: string): PecoDocument {
  const pages = new Map<number, PageData>();
  for (let i = 0; i < TOTAL_PAGES; i++) {
    const block: TextBlock = {
      id: `p${i}-b0`,
      text: `${EDIT_PREFIX}${i}`,
      originalText: `${EDIT_PREFIX}${i}`,
      bbox: { x: 50, y: 750, width: 200, height: 12 },
      writingMode: 'horizontal',
      order: 0,
      isNew: false,
      isDirty: true,
    };
    pages.set(i, {
      pageIndex: i,
      width: 595,
      height: 842,
      textBlocks: [block],
      isDirty: true,
      thumbnail: null,
    });
  }
  return {
    filePath,
    fileName: 'synthetic_500.pdf',
    totalPages: TOTAL_PAGES,
    metadata: {},
    pages,
  };
}

/**
 * BB のみ変更する PecoDocument を組み立てる。
 * - テキストは元 PDF に書き込まれたものと **同一** (ORIG_MARKER_{i})
 * - bbox の x/y を任意量シフト (デフォルト (+50, -50))
 * - page.isDirty=true  (useBlockDragResize の修正で立つようになったフラグ)
 */
function buildBboxOnlyEditedDocument(
  filePath: string,
  shift: { dx: number; dy: number } = { dx: 50, dy: -50 },
): PecoDocument {
  const origX = 50;
  const origY = 750;
  const pages = new Map<number, PageData>();
  for (let i = 0; i < TOTAL_PAGES; i++) {
    const block: TextBlock = {
      id: `p${i}-b0`,
      text: `${ORIG_PREFIX}${i}`,            // ← テキストは元のまま
      originalText: `${ORIG_PREFIX}${i}`,
      bbox: {
        x: origX + shift.dx,
        y: origY + shift.dy,
        width: 200,
        height: 12,
      },
      writingMode: 'horizontal',
      order: 0,
      isNew: false,
      isDirty: true,
    };
    pages.set(i, {
      pageIndex: i,
      width: 595,
      height: 842,
      textBlocks: [block],
      isDirty: true,
      thumbnail: null,
    });
  }
  return {
    filePath,
    fileName: 'synthetic_500.pdf',
    totalPages: TOTAL_PAGES,
    metadata: {},
    pages,
  };
}

/** PDF content stream 上での文字列マッチ用。pdf-lib は drawText を hex literal
 *  (`<4F5249...>`) で書き出すため、ASCII テキストはその hex 表現で検索する必要がある。 */
function markerHex(marker: string): string {
  return Array.from(marker)
    .map((c) => c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
    .join('');
}

/** content stream バイト列に marker（ASCII literal または hex literal 形式）が含まれるか */
function streamContainsMarker(streamText: string, marker: string): boolean {
  return streamText.includes(marker) || streamText.includes(markerHex(marker));
}

/** pdf-lib のページ Contents (PDFRawStream or PDFArray<PDFRawStream>) を decode して
 *  連結バイト列で返す。FlateDecode 以外は null。 */
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
      try {
        chunks.push(inflate(raw));
      } catch {
        return null;
      }
    } else if (!filter) {
      chunks.push(raw);
    } else {
      // 複合 filter 等は本テストでは想定外
      return null;
    }
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** 出力 PDF の InfoDict から PecoToolBBoxes JSON を取り出す。 */
function readBBoxMeta(doc: PDFDocument): Record<string, unknown> | null {
  const infoDict = (doc as unknown as { getInfoDict(): PDFDict | undefined }).getInfoDict();
  if (!infoDict) return null;
  const v = infoDict.get(PDFName.of('PecoToolBBoxes'));
  if (v instanceof PDFHexString || v instanceof PDFString) {
    try {
      return JSON.parse(v.decodeText());
    } catch {
      return null;
    }
  }
  return null;
}

beforeAll(() => {
  // 環境によっては crypto.randomUUID が無いケースへの保険
  if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.randomUUID) {
    (globalThis as unknown as { crypto: Crypto }).crypto = {
      ...(globalThis.crypto ?? {}),
      randomUUID: () => `${Math.random().toString(16).slice(2)}-${Date.now()}`,
    } as unknown as Crypto;
  }
});

beforeEach(() => {
  __setSaveWorkerFactoryForTest(() => null); // main thread fallback を強制
  __resetSaveStateForTest();
});

describe('LOAD TEST: 500 ページ全件編集 → 保存', () => {
  it('出力 PDF の全 500 ページが書き換わり、bboxMeta に 500 件のエントリが入る', async () => {
    const originalBytes = await buildSyntheticPdf();
    const originalDoc = await PDFDocument.load(originalBytes);
    expect(originalDoc.getPages().length).toBe(TOTAL_PAGES);

    // 念のため: オリジナルには ORIG マーカーが存在し、EDIT マーカーは無いこと
    for (let i = 0; i < TOTAL_PAGES; i += 100) {
      const decoded = decodePageContents(originalDoc, i);
      const text = decoded ? Buffer.from(decoded).toString('latin1') : '';
      expect(streamContainsMarker(text, `${ORIG_PREFIX}${i}`)).toBe(true);
      expect(streamContainsMarker(text, `${EDIT_PREFIX}${i}`)).toBe(false);
    }

    const doc = buildEditedDocument('synthetic.pdf');
    const t0 = Date.now();
    const savedBytes = await savePDF({ bytes: originalBytes }, doc);
    const elapsed = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log(
      `[LOAD TEST] savePDF ${TOTAL_PAGES}ページ: ${elapsed}ms, 出力 ${(savedBytes.byteLength / 1024).toFixed(1)} KB`,
    );
    expect(savedBytes.byteLength).toBeGreaterThan(0);

    const savedDoc = await PDFDocument.load(savedBytes);
    expect(savedDoc.getPages().length).toBe(TOTAL_PAGES);

    // --- (1) bboxMeta に全 500 ページのエントリが入っている ---
    const bboxMeta = readBBoxMeta(savedDoc);
    expect(bboxMeta).not.toBeNull();
    const metaKeys = Object.keys(bboxMeta!).map((k) => Number(k)).sort((a, b) => a - b);
    expect(metaKeys.length).toBe(TOTAL_PAGES);
    expect(metaKeys[0]).toBe(0);
    expect(metaKeys[TOTAL_PAGES - 1]).toBe(TOTAL_PAGES - 1);
    // 各エントリに text フィールドが 1 件ずつあり、EDIT マーカーが含まれている
    for (let i = 0; i < TOTAL_PAGES; i++) {
      const entry = (bboxMeta as Record<string, Array<{ text: string }>>)[String(i)];
      expect(entry).toHaveLength(1);
      expect(entry[0].text).toBe(`${EDIT_PREFIX}${i}`);
    }

    // --- (2)(3) 全ページの content stream が書き換わっている ---
    //   ORIG マーカーが消え、EDIT マーカーに対応する drawText 痕跡が残っていること
    //   (drawText の結果は Helvetica で書かれた "Tj" オペレータとして stream 中に現れる)
    const missingEdit: number[] = [];
    const stillHasOrig: number[] = [];
    const sameAsOriginal: number[] = [];
    for (let i = 0; i < TOTAL_PAGES; i++) {
      const origDecoded = decodePageContents(originalDoc, i);
      const newDecoded = decodePageContents(savedDoc, i);
      // バイト差分
      if (origDecoded && newDecoded && origDecoded.length === newDecoded.length) {
        let diff = false;
        for (let j = 0; j < origDecoded.length; j++) {
          if (origDecoded[j] !== newDecoded[j]) { diff = true; break; }
        }
        if (!diff) sameAsOriginal.push(i);
      }
      const text = newDecoded ? Buffer.from(newDecoded).toString('latin1') : '';
      if (streamContainsMarker(text, `${ORIG_PREFIX}${i}`)) stillHasOrig.push(i);
      if (!streamContainsMarker(text, `${EDIT_PREFIX}${i}`)) missingEdit.push(i);
    }

    // 1 ページも素通りしていない
    expect(sameAsOriginal).toEqual([]);
    // 1 ページもオリジナルテキストが残っていない (stripTextBlocks 成功)
    expect(stillHasOrig).toEqual([]);
    // 1 ページも編集テキストが抜けていない (drawText 成功)
    expect(missingEdit).toEqual([]);
  }, 180_000);

  it('【BB のみ変更】テキスト不変で BB 位置だけ 500 ページ全件ズラす → 全ページで差分が生成される', async () => {
    const originalBytes = await buildSyntheticPdf();
    const originalDoc = await PDFDocument.load(originalBytes);
    expect(originalDoc.getPages().length).toBe(TOTAL_PAGES);

    // BB のみ変更 (テキスト = ORIG_MARKER_{i} のまま、bbox 位置を (+50, -50) シフト)
    const doc = buildBboxOnlyEditedDocument('synthetic.pdf', { dx: 50, dy: -50 });

    const t0 = Date.now();
    const savedBytes = await savePDF({ bytes: originalBytes }, doc);
    const elapsed = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log(
      `[LOAD TEST/BB-only] savePDF ${TOTAL_PAGES}ページ: ${elapsed}ms, 出力 ${(savedBytes.byteLength / 1024).toFixed(1)} KB`,
    );

    const savedDoc = await PDFDocument.load(savedBytes);
    expect(savedDoc.getPages().length).toBe(TOTAL_PAGES);

    // --- (1) bboxMeta に 500 件あり、各エントリの bbox が新位置 (100, 700) になっている ---
    const bboxMeta = readBBoxMeta(savedDoc);
    expect(bboxMeta).not.toBeNull();
    const meta = bboxMeta as Record<string, Array<{ text: string; bbox: { x: number; y: number } }>>;
    expect(Object.keys(meta).length).toBe(TOTAL_PAGES);
    for (let i = 0; i < TOTAL_PAGES; i++) {
      const entry = meta[String(i)];
      expect(entry).toHaveLength(1);
      expect(entry[0].text).toBe(`${ORIG_PREFIX}${i}`);     // テキストは元のまま
      expect(entry[0].bbox.x).toBe(100);                     // 位置だけ変わっている
      expect(entry[0].bbox.y).toBe(700);
    }

    // --- (2) 全ページで content stream がオリジナルと byte 単位で違う ---
    //   (ORIG マーカーは残るが、Tm オペレータの座標値が変わるため stream は別物になる)
    const sameAsOriginal: number[] = [];
    const missingMarker: number[] = [];
    const origPosRemains: number[] = [];
    for (let i = 0; i < TOTAL_PAGES; i++) {
      const origDecoded = decodePageContents(originalDoc, i);
      const newDecoded = decodePageContents(savedDoc, i);

      // byte 単位差分 (同一長なら各 byte 比較、長さが違えばそれ自体が差分)
      if (origDecoded && newDecoded && origDecoded.length === newDecoded.length) {
        let diff = false;
        for (let j = 0; j < origDecoded.length; j++) {
          if (origDecoded[j] !== newDecoded[j]) { diff = true; break; }
        }
        if (!diff) sameAsOriginal.push(i);
      }

      const text = newDecoded ? Buffer.from(newDecoded).toString('latin1') : '';
      // テキスト自体は残っている (drawText が新 bbox で書き直した)
      if (!streamContainsMarker(text, `${ORIG_PREFIX}${i}`)) missingMarker.push(i);
      // ただし 元の描画位置 "50 750 Tm" は消えている必要がある (stripTextBlocks 成功)
      if (/\b50 750 Tm\b/.test(text)) origPosRemains.push(i);
    }

    // 全 500 ページで差分が出ている (BB-only 編集でも保存されている)
    expect(sameAsOriginal).toEqual([]);
    // 全ページでテキストマーカーが残っている (drawText 実行済み)
    expect(missingMarker).toEqual([]);
    // 全ページで元の描画位置 (50 750) は消えている (stripTextBlocks 実行済み)
    expect(origPosRemains).toEqual([]);
  }, 180_000);

  // 微移動でも差分が出るかを、複数の shift 量でパラメータ化して検証する。
  // - 1 単位: 1 mouse-pixel 相当 (100% zoom で dx=1)
  // - 0.5 単位: 高ズーム時の 1 mouse-pixel 相当
  // - 0.1 単位: pdf-lib 数値シリアライズ精度の境界チェック
  // - 0.01 単位: サブピクセル、PDF 仕様上の座標精度 (通常 0.01 単位で丸め)
  it.each([
    { label: '1 単位 (100% ズームで 1px)', dx: 1, dy: 0 },
    { label: '0.5 単位 (200% ズームで 1px)', dx: 0.5, dy: 0 },
    { label: '0.1 単位 (極小)', dx: 0.1, dy: 0 },
    { label: '0.01 単位 (サブピクセル)', dx: 0.01, dy: 0 },
  ])('【微移動】$label だけ 500 ページ全件ズラす → 全ページで差分が出るか', async ({ dx, dy }) => {
    const originalBytes = await buildSyntheticPdf();
    const originalDoc = await PDFDocument.load(originalBytes);

    const doc = buildBboxOnlyEditedDocument('synthetic.pdf', { dx, dy });

    const t0 = Date.now();
    const savedBytes = await savePDF({ bytes: originalBytes }, doc);
    const elapsed = Date.now() - t0;
    const savedDoc = await PDFDocument.load(savedBytes);

    const sameAsOriginal: number[] = [];
    for (let i = 0; i < TOTAL_PAGES; i++) {
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

    // eslint-disable-next-line no-console
    console.log(
      `[LOAD TEST/micro] shift (${dx}, ${dy}): ${elapsed}ms, 差分なしページ ${sameAsOriginal.length}/${TOTAL_PAGES}`,
    );

    expect(sameAsOriginal).toEqual([]);
  }, 180_000);
});
