/**
 * PCT-098: ゴールデンマスター回帰スイート — 合成 PDF コーパスジェネレータ
 *
 * pdf-lib (@cantoo/pdf-lib) を使って、テスト実行時に合成 PDF を生成する。
 * バイナリはコミットしない。生成は deterministic（Date.now/Math.random 不使用）。
 * ただしバイト列は pdf-lib の日付スタンプ（CreationDate など）で実行毎に揺れる。
 * 意味比較（テキスト・bbox・order 等）のみ安定しており、バイト完全一致は保証しない。
 * deterministic UUID polyfill は Node 19+ では crypto.randomUUID が組み込み済みのため
 * 実質 no-op になる（ensurePdfjsEnvForCorpus 内のガード条件を参照）。
 *
 * 生成するコーパス類型:
 *   C01: 横書き複数ブロック・複数ページ（基本）
 *   C02: /Rotate 90/180/270 の各ページ（PCT-096 領域）
 *   C03: 縦書きブロック混在（writingMode vertical）
 *   C04: 既存テキスト層あり（外部 OCR PDF 風）
 *   C05: PecoToolBBoxes メタあり（自己保存 PDF 風 — buildPdfDocument 出力を再利用）
 *   C06: 空ページ含み・ページサイズ混在
 *   C07: confidence 付きブロック（要確認マーク）
 */

import { PDFDocument, degrees, rgb, StandardFonts } from '@cantoo/pdf-lib';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PecoDocument, PageData, TextBlock, WritingMode } from '../../../types';
import { buildPdfDocument } from '../../../utils/pdfSaver';

const FONT_PATH = resolve(__dirname, '../../../../public/fonts/IPAexGothic.ttf');
const FONT_PATH_FALLBACK = resolve(__dirname, '../../../../public/fonts/NotoSans-Regular.ttf');

export function loadFontBytesForCorpus(): ArrayBuffer {
  const path = existsSync(FONT_PATH) ? FONT_PATH : FONT_PATH_FALLBACK;
  const buf = readFileSync(path);
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

// ---------------------------------------------------------------------------
// 固定値ヘルパー: deterministic な ID/座標生成
// ---------------------------------------------------------------------------

function blockId(page: number, idx: number): string {
  return `p${page}-b${idx}`;
}

function makeBlock(
  page: number,
  idx: number,
  text: string,
  x: number,
  y: number,
  w: number,
  h: number,
  writingMode: WritingMode = 'horizontal',
  confidence?: number,
): TextBlock {
  return {
    id: blockId(page, idx),
    text,
    originalText: text,
    bbox: { x, y, width: w, height: h },
    writingMode,
    order: idx,
    isNew: false,
    isDirty: true,
    confidence,
  };
}

function makePageData(
  pageIndex: number,
  width: number,
  height: number,
  textBlocks: TextBlock[],
): PageData {
  return {
    pageIndex,
    width,
    height,
    textBlocks,
    isDirty: textBlocks.length > 0,
    thumbnail: null,
    isTextExtracted: true,
  };
}

function makeDoc(pages: Map<number, PageData>, filePath = 'corpus.pdf'): PecoDocument {
  return {
    filePath,
    fileName: filePath.replace(/\\/g, '/').split('/').pop() ?? 'corpus.pdf',
    totalPages: pages.size,
    metadata: {},
    pages,
  };
}

// ---------------------------------------------------------------------------
// 空の 1 ページ PDF を生成するヘルパー（テキスト層なし）
// ---------------------------------------------------------------------------

async function makeBlankPdf(
  pages: Array<{ width: number; height: number; rotate?: 0 | 90 | 180 | 270 }>,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (const { width, height, rotate } of pages) {
    const page = pdf.addPage([width, height]);
    if (rotate && rotate !== 0) {
      page.setRotation(degrees(rotate));
    }
  }
  return pdf.save({ useObjectStreams: false, addDefaultPage: false });
}

// ---------------------------------------------------------------------------
// pdfjs 環境のセットアップ（globalThis.crypto / ReadableStream）
// ---------------------------------------------------------------------------

export async function ensurePdfjsEnvForCorpus(): Promise<void> {
  if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.randomUUID) {
    (globalThis as unknown as { crypto: Crypto }).crypto = {
      ...(globalThis.crypto ?? {}),
      randomUUID: () => {
        // deterministic: 固定カウンタベース
        const base = '00000000-0000-0000-0000-';
        const counter = String(++deterministicCounter).padStart(12, '0');
        return `${base}${counter}` as `${string}-${string}-${string}-${string}-${string}`;
      },
    } as unknown as Crypto;
  }
  if (typeof (globalThis as unknown as Record<string, unknown>).ReadableStream === 'undefined') {
    const streams = await import('node:stream/web');
    (globalThis as unknown as Record<string, unknown>).ReadableStream = streams.ReadableStream;
    (globalThis as unknown as Record<string, unknown>).WritableStream = streams.WritableStream;
    (globalThis as unknown as Record<string, unknown>).TransformStream = streams.TransformStream;
  }
}

let deterministicCounter = 0;

export function resetDeterministicCounter(): void {
  deterministicCounter = 0;
}

// ---------------------------------------------------------------------------
// C01: 横書き複数ブロック・複数ページ（基本）
// 2ページ、各ページに 3 ブロック（横書き）
// ---------------------------------------------------------------------------

export interface CorpusEntry {
  /** 入力 PDF bytes（buildPdfDocument に渡す元 PDF） */
  inputBytes: Uint8Array;
  /** 入力に対応する PecoDocument（textBlocks が入力定義を表す） */
  doc: PecoDocument;
  /** ページ寸法の期待値 [{ width, height }] */
  expectedPageDims: Array<{ width: number; height: number }>;
  /** 各ページの /Rotate 期待値（0=未設定含む） */
  expectedRotations: number[];
  /** corpus ID */
  id: string;
}

export async function buildC01(): Promise<CorpusEntry> {
  const W = 595, H = 842;
  const inputBytes = await makeBlankPdf([
    { width: W, height: H },
    { width: W, height: H },
  ]);

  const pages = new Map<number, PageData>([
    [0, makePageData(0, W, H, [
      makeBlock(0, 0, 'Hello World',   50,  50, 200, 20),
      makeBlock(0, 1, 'Second Block',  50, 100, 200, 20),
      makeBlock(0, 2, 'Third Block',   50, 150, 200, 20),
    ])],
    [1, makePageData(1, W, H, [
      makeBlock(1, 0, 'Page Two A',    50,  50, 200, 20),
      makeBlock(1, 1, 'Page Two B',    50, 100, 200, 20),
      makeBlock(1, 2, 'Page Two C',    50, 150, 200, 20),
    ])],
  ]);

  return {
    id: 'C01',
    inputBytes,
    doc: makeDoc(pages, 'c01.pdf'),
    expectedPageDims: [{ width: W, height: H }, { width: W, height: H }],
    expectedRotations: [0, 0],
  };
}

// ---------------------------------------------------------------------------
// C02: /Rotate 90/180/270 の各ページ（PCT-096 領域）
// 3ページ: rotate=90, 180, 270 — 各1ブロック
// ---------------------------------------------------------------------------

export async function buildC02(): Promise<CorpusEntry> {
  // /Rotate が設定されると viewport の width/height が swap される
  // rotate=90/270: viewport=(H, W)、rotate=180: viewport=(W, H)
  const W = 595, H = 842;
  const inputBytes = await makeBlankPdf([
    { width: W, height: H, rotate: 90 },
    { width: W, height: H, rotate: 180 },
    { width: W, height: H, rotate: 270 },
  ]);

  // viewport 空間: rotate=90/270 では (842, 595)、rotate=180 では (595, 842)
  const vW90 = H, vH90 = W;   // rotate=90: viewport W=842, H=595
  const vW180 = W, vH180 = H; // rotate=180: viewport W=595, H=842
  const vW270 = H, vH270 = W; // rotate=270: viewport W=842, H=595

  const pages = new Map<number, PageData>([
    [0, makePageData(0, vW90,  vH90,  [makeBlock(0, 0, 'Rotated90',  50, 50, 200, 20)], )],
    [1, makePageData(1, vW180, vH180, [makeBlock(1, 0, 'Rotated180', 50, 50, 200, 20)])],
    [2, makePageData(2, vW270, vH270, [makeBlock(2, 0, 'Rotated270', 50, 50, 200, 20)])],
  ]);

  // PageData.rotation は userRotation（UI 操作由来）—今回は入力 PDF の /Rotate をそのまま保持するので未設定
  return {
    id: 'C02',
    inputBytes,
    doc: makeDoc(pages, 'c02.pdf'),
    expectedPageDims: [
      { width: W, height: H }, // PDF user-space dims（/Rotate 前）
      { width: W, height: H },
      { width: W, height: H },
    ],
    expectedRotations: [90, 180, 270],
  };
}

// ---------------------------------------------------------------------------
// C03: 縦書きブロック混在
// 2ページ: ページ0=横書き+縦書き混在、ページ1=縦書きのみ
// ---------------------------------------------------------------------------

export async function buildC03(): Promise<CorpusEntry> {
  const W = 595, H = 842;
  const inputBytes = await makeBlankPdf([
    { width: W, height: H },
    { width: W, height: H },
  ]);

  const pages = new Map<number, PageData>([
    [0, makePageData(0, W, H, [
      makeBlock(0, 0, 'Horizontal Block', 50, 50, 200, 20, 'horizontal'),
      // 縦書き: width < height（縦長 bbox）
      makeBlock(0, 1, '縦書きテキスト', 500, 50, 24, 160, 'vertical'),
    ])],
    [1, makePageData(1, W, H, [
      makeBlock(1, 0, '縦書きA', 500, 50, 24, 120, 'vertical'),
      makeBlock(1, 1, '縦書きB', 460, 50, 24, 120, 'vertical'),
    ])],
  ]);

  return {
    id: 'C03',
    inputBytes,
    doc: makeDoc(pages, 'c03.pdf'),
    expectedPageDims: [{ width: W, height: H }, { width: W, height: H }],
    expectedRotations: [0, 0],
  };
}

// ---------------------------------------------------------------------------
// C04: 既存テキスト層あり（外部 OCR PDF 風）
// Helvetica テキストを持つ PDF — 保存後も pdfjs で文字が取れること
// ---------------------------------------------------------------------------

// #358: 既存テキスト層の strip/二重化検証用の識別文字列。
// PecoTool の TextBlock（OCR 結果）とは意図的に**別の文字列**にすることで
// 「既存層が strip された後、この文字列が出現しない」ことをアサートできる。
export const C04_LEGACY_TEXT = 'LEGACY_LAYER_x7';
// PecoTool が OCR した結果のテキスト（TextBlock の text フィールド）
export const C04_BLOCK_TEXT_0 = 'Existing text layer content';
export const C04_BLOCK_TEXT_1 = 'Second line of external OCR';

export async function buildC04(): Promise<CorpusEntry> {
  const W = 595, H = 842;
  const pdf = await PDFDocument.create();
  const helvetica = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([W, H]);
  // #358: 既存テキスト層を C04_LEGACY_TEXT で識別可能にする。
  // drawText で埋め込む文字列を TextBlock テキストとは別の文字列にして、
  // stripTextBlocks 後に pdfjs が C04_LEGACY_TEXT を返さないことを検証できるようにする。
  page.drawText(C04_LEGACY_TEXT, {
    x: 50,
    y: H - 100,
    size: 12,
    font: helvetica,
    color: rgb(0, 0, 0),
  });
  page.drawText(C04_LEGACY_TEXT + '_LINE2',  {
    x: 50,
    y: H - 130,
    size: 12,
    font: helvetica,
    color: rgb(0, 0, 0),
  });
  const inputBytes = await pdf.save({ useObjectStreams: false, addDefaultPage: false });

  // PecoTool が OCR した結果（TextBlock 座標は viewport-space で一致させる）
  // TextBlock のテキストは既存層文字列（C04_LEGACY_TEXT）とは別にする
  const pages = new Map<number, PageData>([
    [0, makePageData(0, W, H, [
      makeBlock(0, 0, C04_BLOCK_TEXT_0, 50, 100 - 20, 260, 20),
      makeBlock(0, 1, C04_BLOCK_TEXT_1,  50, 130 - 20, 260, 20),
    ])],
  ]);

  return {
    id: 'C04',
    inputBytes,
    doc: makeDoc(pages, 'c04.pdf'),
    expectedPageDims: [{ width: W, height: H }],
    expectedRotations: [0],
  };
}

// ---------------------------------------------------------------------------
// C05: PecoToolBBoxes メタあり（自己保存 PDF 風）
// buildPdfDocument 出力を入力として再利用し、2 サイクル目の保存を検証
// ---------------------------------------------------------------------------

export async function buildC05(fontBytes: ArrayBuffer): Promise<CorpusEntry> {
  const W = 595, H = 842;

  // 1 サイクル目: blank PDF → buildPdfDocument でメタ付き PDF を生成
  const blank = await makeBlankPdf([{ width: W, height: H }]);
  const docCycle1 = makeDoc(new Map<number, PageData>([
    [0, makePageData(0, W, H, [
      makeBlock(0, 0, 'PecoTool saved text', 50, 50, 200, 20),
      makeBlock(0, 1, 'Another block',       50, 90, 200, 20),
    ])],
  ]), 'c05_cycle1.pdf');

  // 1 サイクル目保存 — これが C05 の "入力"
  const savedCycle1 = await buildPdfDocument(blank, docCycle1, fontBytes);

  // 2 サイクル目の入力ドキュメント（内容は同一 — meta 保存の不変性を検証）
  const docCycle2 = makeDoc(new Map<number, PageData>([
    [0, makePageData(0, W, H, [
      makeBlock(0, 0, 'PecoTool saved text', 50, 50, 200, 20),
      makeBlock(0, 1, 'Another block',       50, 90, 200, 20),
    ])],
  ]), 'c05_cycle2.pdf');

  return {
    id: 'C05',
    inputBytes: savedCycle1,
    doc: docCycle2,
    expectedPageDims: [{ width: W, height: H }],
    expectedRotations: [0],
  };
}

// ---------------------------------------------------------------------------
// C06: 空ページ含み・ページサイズ混在
// 3ページ: A4 textブロックあり / A3 textブロックあり / 空ページ（ブロックなし）
// ---------------------------------------------------------------------------

export async function buildC06(): Promise<CorpusEntry> {
  const A4W = 595, A4H = 842;
  const A3W = 842, A3H = 1191;
  const inputBytes = await makeBlankPdf([
    { width: A4W, height: A4H },
    { width: A3W, height: A3H },
    { width: A4W, height: A4H },
  ]);

  const pages = new Map<number, PageData>([
    [0, makePageData(0, A4W, A4H, [
      makeBlock(0, 0, 'A4 page text', 50, 50, 200, 20),
    ])],
    [1, makePageData(1, A3W, A3H, [
      makeBlock(1, 0, 'A3 page text', 50, 50, 300, 24),
    ])],
    // 空ページ（isDirty=false にならないよう isDirty を維持しつつ blocks は空）
    [2, {
      pageIndex: 2,
      width: A4W,
      height: A4H,
      textBlocks: [],
      isDirty: false,
      thumbnail: null,
      isTextExtracted: true,
    }],
  ]);

  return {
    id: 'C06',
    inputBytes,
    doc: makeDoc(pages, 'c06.pdf'),
    expectedPageDims: [
      { width: A4W, height: A4H },
      { width: A3W, height: A3H },
      { width: A4W, height: A4H },
    ],
    expectedRotations: [0, 0, 0],
  };
}

// ---------------------------------------------------------------------------
// C07: confidence 付きブロック（要確認マーク）
// PCT-052 領域: confidence が保存・再ロードで保持されることを検証
// ---------------------------------------------------------------------------

export async function buildC07(): Promise<CorpusEntry> {
  const W = 595, H = 842;
  const inputBytes = await makeBlankPdf([
    { width: W, height: H },
    { width: W, height: H },
  ]);

  const pages = new Map<number, PageData>([
    [0, makePageData(0, W, H, [
      makeBlock(0, 0, 'High confidence',      50,  50, 200, 20, 'horizontal', 0.95),
      makeBlock(0, 1, 'Low confidence',       50, 100, 200, 20, 'horizontal', 0.30),
      makeBlock(0, 2, 'No confidence',        50, 150, 200, 20, 'horizontal', undefined),
    ])],
    [1, makePageData(1, W, H, [
      makeBlock(1, 0, 'Medium confidence',    50,  50, 200, 20, 'horizontal', 0.65),
      makeBlock(1, 1, 'Threshold confidence', 50, 100, 200, 20, 'horizontal', 0.50),
    ])],
  ]);

  return {
    id: 'C07',
    inputBytes,
    doc: makeDoc(pages, 'c07.pdf'),
    expectedPageDims: [{ width: W, height: H }, { width: W, height: H }],
    expectedRotations: [0, 0],
  };
}

// ---------------------------------------------------------------------------
// 大規模スケール: N ページ可変コーパス（LRU 境界超えテスト用・高密度対応）
//
// 各ページに blocksPerPage 個のブロックを配置する。
// 各ブロックの text には "L-<pageIndex>-<blockIndex>" の一意マーカーを埋める。
// これにより保存後の bboxMeta からブロック欠落をマーカー単位で特定できる。
//
// 高密度ケース向け座標配置:
//   ページ内に収まるよう格子状（グリッド）に配置する。
//   列数 = ceil(sqrt(blocksPerPage)) で折り返し、行列のセルが重ならないよう
//   ブロック幅/高さをページ寸法から逆算する。
//   はみ出しによって保存側がブロックを弾く事故を防ぐ。
// ---------------------------------------------------------------------------

/** デフォルトの 1 ページあたりの合成ブロック数（後方互換） */
const LARGE_SCALE_DEFAULT_BLOCKS_PER_PAGE = 3;

/**
 * 大規模合成コーパス（N ページ可変・密度可変）を生成する。
 *
 * @param pageCount    生成するページ数（退避境界を跨ぐ 51 以上を推奨）
 * @param blocksPerPage 1 ページあたりのブロック数（省略時=3・後方互換）
 * @returns            CorpusEntry（inputBytes / doc / expectedPageDims / expectedRotations / id）
 *
 * 各ブロックの text: "L-<pageIndex>-<blockIndex>"（一意マーカー）
 * resetDeterministicCounter() を呼んでから使うこと（goldenCorpus 既存 API に準拠）。
 */
export async function buildLargeScale(
  pageCount: number,
  blocksPerPage: number = LARGE_SCALE_DEFAULT_BLOCKS_PER_PAGE,
): Promise<CorpusEntry> {
  const W = 595, H = 842;

  // 格子配置の計算
  // 列数を sqrt(blocksPerPage) の切り上げで決め、行列セルが均等に敷き詰まるようにする。
  // マージン 20px を確保し、残りをセルサイズとして等分する。
  const MARGIN = 20;
  const cols = Math.ceil(Math.sqrt(blocksPerPage));
  const rows = Math.ceil(blocksPerPage / cols);
  const availW = W - MARGIN * 2;
  const availH = H - MARGIN * 2;
  const cellW = Math.floor(availW / cols);
  const cellH = Math.floor(availH / rows);
  // ブロック自体のサイズはセルより少し小さく（隣接ブロックとの隙間を 2px 確保）
  const bW = Math.max(1, cellW - 2);
  const bH = Math.max(1, cellH - 2);

  const pageDefs = Array.from({ length: pageCount }, () => ({ width: W, height: H }));
  const inputBytes = await makeBlankPdf(pageDefs);

  const pages = new Map<number, PageData>();
  for (let pi = 0; pi < pageCount; pi++) {
    const blocks: TextBlock[] = [];
    for (let bi = 0; bi < blocksPerPage; bi++) {
      const col = bi % cols;
      const row = Math.floor(bi / cols);
      const x = MARGIN + col * cellW;
      const y = MARGIN + row * cellH;
      blocks.push(makeBlock(pi, bi, `L-${pi}-${bi}`, x, y, bW, bH));
    }
    pages.set(pi, makePageData(pi, W, H, blocks));
  }

  return {
    id: `LARGE_SCALE_${pageCount}_${blocksPerPage}`,
    inputBytes,
    doc: makeDoc(pages, `large_scale_${pageCount}_${blocksPerPage}.pdf`),
    expectedPageDims: pageDefs.map(() => ({ width: W, height: H })),
    expectedRotations: pageDefs.map(() => 0),
  };
}

// ---------------------------------------------------------------------------
// 全コーパス一括生成
// ---------------------------------------------------------------------------

export interface AllCorpus {
  C01: CorpusEntry;
  C02: CorpusEntry;
  C03: CorpusEntry;
  C04: CorpusEntry;
  C05: CorpusEntry;
  C06: CorpusEntry;
  C07: CorpusEntry;
}

export async function buildAllCorpus(fontBytes: ArrayBuffer): Promise<AllCorpus> {
  const [C01, C02, C03, C04, C05, C06, C07] = await Promise.all([
    buildC01(),
    buildC02(),
    buildC03(),
    buildC04(),
    buildC05(fontBytes),
    buildC06(),
    buildC07(),
  ]);
  return { C01, C02, C03, C04, C05, C06, C07 };
}
