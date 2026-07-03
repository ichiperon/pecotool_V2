/**
 * PCT-098: ゴールデンマスター回帰スイート
 *
 * 今後の全改修（保存単一化・状態再設計）の安全網として機能する。
 * 合成 PDF コーパス（goldenCorpus.ts）を実行時に生成し、保存往復の意味的不変性を検証する。
 *
 * 検証対象不変条件:
 *   S-12: shouldUseSavedMeta がメタ経路を選ぶことを2サイクル耐久内で検証（pdfTextExtractor.ts）
 *   S-13: sanitizeBBoxMetaRecord は不正エントリのみ drop（all-or-nothing 禁止）
 *   A-07: 各 BB 末尾に invisible スペース（U+0020, renderMode 3）
 *   C-03: pdfSaver / pdf.worker.ts の対称性（PCT-096 setRotation 含む）
 *
 * 比較方向: 入力定義 → 保存出力 → 再ロード検証（一方向）
 *           「出力で入力を上書きする自己満足比較」は行わない。
 *
 * CI 実行目標: 全体 90 秒以内（コーパスは小さく・ページ数は各 2-4）
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { PDFDocument, PDFName, PDFNumber } from '@cantoo/pdf-lib';

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));
// pdfLoader は Tauri/DOM 依存が重いため stub する（goldenMaster は直接使わない）
vi.mock('../../utils/pdfLoader', () => ({
  loadPDF: vi.fn(),
  openPDF: vi.fn(),
  openFreshPdfDoc: vi.fn(),
  getSharedPdfProxy: vi.fn(),
  getCachedPageProxy: vi.fn(),
  destroySharedPdfProxy: vi.fn(),
  saveTemporaryPageDataBatch: vi.fn(),
  getAllTemporaryPageData: vi.fn(),
  clearTemporaryChanges: vi.fn(),
  clearTemporaryChangesForPages: vi.fn(),
  deleteTemporaryPageKeys: vi.fn(),
  clearCachedPages: vi.fn(),
}));

import { buildPdfDocument } from '../../utils/pdfSaver';
import { __handleSavePdfForTest } from '../../utils/pdf.worker';
import { readPecoToolBBoxMetaFromPdfDoc } from '../../utils/pdfPecoToolMetadata';
import { shouldUseSavedMeta } from '../../utils/pdfTextExtractor';
import type { SerializedPageData } from '../../utils/pdfWorkerTypes';
import type { PecoDocument } from '../../types';
import {
  ensurePdfjsEnvForCorpus,
  resetDeterministicCounter,
  loadFontBytesForCorpus,
  buildAllCorpus,
  type CorpusEntry,
  C04_LEGACY_TEXT,
  C04_BLOCK_TEXT_0,
} from './helpers/goldenCorpus';
import { reloadBBoxMetaViaPdfjs, decodePageContents } from './helpers/realPdfFixtures';
// #357: renderMode 3 不可視性の厳密検証ヘルパー
import { assertAllTextSegmentsHaveRenderMode3 } from './helpers/renderModeHelpers';

// ---------------------------------------------------------------------------
// テスト環境セットアップ
// ---------------------------------------------------------------------------

let fontBytes: ArrayBuffer;
let corpus: Awaited<ReturnType<typeof buildAllCorpus>>;

beforeAll(async () => {
  await ensurePdfjsEnvForCorpus();
  fontBytes = loadFontBytesForCorpus();
  corpus = await buildAllCorpus(fontBytes);
}, 60_000);

beforeEach(() => {
  resetDeterministicCounter();
});

// ---------------------------------------------------------------------------
// 共通ヘルパー
// ---------------------------------------------------------------------------

/** 保存済み PDF のページ 0 の /Rotate 値を返す（未設定=0） */
async function readRotate(bytes: Uint8Array, pageIndex = 0): Promise<number> {
  const doc = await PDFDocument.load(new Uint8Array(bytes), { throwOnInvalidObject: false });
  const page = doc.getPage(pageIndex);
  const rotateEntry = page.node.get(PDFName.of('Rotate'));
  if (rotateEntry instanceof PDFNumber) return rotateEntry.asNumber();
  return 0;
}

/** 保存済み PDF の全ページの /Rotate 値を返す */
async function readAllRotations(bytes: Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(new Uint8Array(bytes), { throwOnInvalidObject: false });
  const pages = doc.getPages();
  return pages.map((page) => {
    const rotateEntry = page.node.get(PDFName.of('Rotate'));
    if (rotateEntry instanceof PDFNumber) return rotateEntry.asNumber();
    return 0;
  });
}

/** pdfjs で PDF を開き、テキストを抽出する（xref 健全性 + テキスト取得確認） */
async function extractTextViaPdfjs(bytes: Uint8Array): Promise<string[][]> {
  const pdfjsLib: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const task = pdfjsLib.getDocument({ data: copy, disableWorker: true, disableFontFace: true });
  const doc = await task.promise;
  const totalPages: number = doc.numPages;
  const result: string[][] = [];
  for (let i = 0; i < totalPages; i++) {
    const page = await doc.getPage(i + 1);
    const content = await page.getTextContent();
    const strs = (content.items as Array<{ str?: string }>)
      .map((item) => item.str ?? '')
      .filter((s) => s.trim() !== '');
    result.push(strs);
  }
  try { await doc.cleanup(); } catch { /* ignore */ }
  try { await doc.destroy(); } catch { /* ignore */ }
  return result;
}

/** PecoDocument の pages を Worker 用 SerializedPageData に変換 */
function serializePages(doc: PecoDocument): Record<number, SerializedPageData> {
  const result: Record<number, SerializedPageData> = {};
  for (const [idx, page] of doc.pages.entries()) {
    const { thumbnail: _t, ...rest } = page;
    result[idx] = rest;
  }
  return result;
}

/**
 * 指定ページの content stream をデコードして文字列で返す（latin1）
 * descentRatio の変化は cm 演算子の f（translate Y）に現れる
 * realPdfFixtures.decodePageContents を正本として使用する
 */
async function decodePageContentStream(bytes: Uint8Array, pageIndex = 0): Promise<string> {
  const doc = await PDFDocument.load(new Uint8Array(bytes), { throwOnInvalidObject: false });
  const raw = decodePageContents(doc, pageIndex);
  if (!raw) return '';
  return new TextDecoder('latin1').decode(raw);
}

/**
 * cm 演算子（6 引数）を全て抽出する
 * 書式: a b c d e f cm
 * e=translateX, f=translateY（PDF user space）
 */
function extractCmTranslations(text: string): Array<{ e: number; f: number }> {
  const re = /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+cm\b/g;
  const out: Array<{ e: number; f: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ e: parseFloat(m[5]), f: parseFloat(m[6]) });
  }
  return out;
}

/**
 * 1サイクル分の保存→再ロード検証を行う共通ヘルパー。
 * 返値: { savedBytes, reloadedMeta, reloadedTotalPages }
 */
async function saveAndReload(entry: CorpusEntry): Promise<{
  savedBytes: Uint8Array;
  reloadedMeta: Awaited<ReturnType<typeof reloadBBoxMetaViaPdfjs>>;
}> {
  const savedBytes = await buildPdfDocument(entry.inputBytes, entry.doc, fontBytes);
  const reloadedMeta = await reloadBBoxMetaViaPdfjs(savedBytes);
  return { savedBytes, reloadedMeta };
}

// ---------------------------------------------------------------------------
// 検証 (a): bboxMeta のテキスト・bbox・writingMode・order・confidence が入力と一致
// 許容誤差: bbox は ±0.5
// ---------------------------------------------------------------------------

function assertMetaMatchesInput(entry: CorpusEntry, meta: Record<string, import('./helpers/realPdfFixtures').BBoxMetaEntry[]>): void {
  for (const [pageIdx, pageData] of entry.doc.pages.entries()) {
    const pageKey = String(pageIdx);
    const inputBlocks = pageData.textBlocks
      .slice()
      .sort((a, b) => a.order - b.order);

    if (inputBlocks.length === 0) {
      // 空ページは meta に含まれなくてよい
      continue;
    }

    const reloadedBlocks = meta[pageKey];
    expect(reloadedBlocks, `page ${pageIdx}: meta should exist`).toBeDefined();
    expect(reloadedBlocks.length, `page ${pageIdx}: block count`).toBe(inputBlocks.length);

    for (let i = 0; i < inputBlocks.length; i++) {
      const input = inputBlocks[i];
      const reloaded = reloadedBlocks[i];

      expect(reloaded.text, `page ${pageIdx}, block ${i}: text`).toBe(input.text);
      expect(reloaded.writingMode, `page ${pageIdx}, block ${i}: writingMode`).toBe(input.writingMode);
      expect(reloaded.order, `page ${pageIdx}, block ${i}: order`).toBe(i);

      expect(reloaded.bbox.x, `page ${pageIdx}, block ${i}: bbox.x`).toBeCloseTo(input.bbox.x, 0);
      expect(reloaded.bbox.y, `page ${pageIdx}, block ${i}: bbox.y`).toBeCloseTo(input.bbox.y, 0);
      expect(reloaded.bbox.width, `page ${pageIdx}, block ${i}: bbox.width`).toBeCloseTo(input.bbox.width, 0);
      expect(reloaded.bbox.height, `page ${pageIdx}, block ${i}: bbox.height`).toBeCloseTo(input.bbox.height, 0);
    }
  }
}

/** confidence の比較（S-07/C-05 の PCT-052 領域） */
function assertConfidenceMatchesInput(
  entry: CorpusEntry,
  meta: Record<string, Array<{ confidence?: number; text: string }>>,
): void {
  for (const [pageIdx, pageData] of entry.doc.pages.entries()) {
    const pageKey = String(pageIdx);
    const inputBlocks = pageData.textBlocks.slice().sort((a, b) => a.order - b.order);
    if (inputBlocks.length === 0) continue;

    const reloadedBlocks = meta[pageKey];
    if (!reloadedBlocks) continue;

    for (let i = 0; i < inputBlocks.length; i++) {
      const input = inputBlocks[i];
      const reloaded = reloadedBlocks[i];
      if (input.confidence !== undefined) {
        expect(reloaded.confidence, `page ${pageIdx}, block ${i}: confidence`).toBeCloseTo(
          input.confidence, 5,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 検証 (c): ページ数・ページ寸法不変
// ---------------------------------------------------------------------------

async function assertPageDimsUnchanged(bytes: Uint8Array, entry: CorpusEntry): Promise<void> {
  const doc = await PDFDocument.load(new Uint8Array(bytes), { throwOnInvalidObject: false });
  const pages = doc.getPages();
  expect(pages.length, 'page count').toBe(entry.expectedPageDims.length);
  for (let i = 0; i < pages.length; i++) {
    const { width, height } = pages[i].getSize();
    const expected = entry.expectedPageDims[i];
    // pdf-lib の getSize() は PDF user-space の寸法を返す（/Rotate 前）
    expect(width, `page ${i}: width`).toBeCloseTo(expected.width, 0);
    expect(height, `page ${i}: height`).toBeCloseTo(expected.height, 0);
  }
}

// ---------------------------------------------------------------------------
// C01: 横書き複数ブロック・複数ページ（基本）
// ---------------------------------------------------------------------------

describe('PCT-098 C01: 横書き複数ブロック・複数ページ', () => {
  it('(a) 保存→再ロード: テキスト/bbox/writingMode/order が入力と一致', async () => {
    const { reloadedMeta } = await saveAndReload(corpus.C01);
    expect(reloadedMeta.meta, 'meta should not be null').not.toBeNull();
    assertMetaMatchesInput(corpus.C01, reloadedMeta.meta!);
  }, 30_000);

  it('(b) /Rotate が期待値通り（0）', async () => {
    const savedBytes = await buildPdfDocument(corpus.C01.inputBytes, corpus.C01.doc, fontBytes);
    const rotations = await readAllRotations(savedBytes);
    for (let i = 0; i < rotations.length; i++) {
      expect(rotations[i], `page ${i} rotation`).toBe(corpus.C01.expectedRotations[i]);
    }
  }, 30_000);

  it('(c) ページ数・ページ寸法不変', async () => {
    const savedBytes = await buildPdfDocument(corpus.C01.inputBytes, corpus.C01.doc, fontBytes);
    await assertPageDimsUnchanged(savedBytes, corpus.C01);
  }, 30_000);

  it('(d) pdfjs で開ける（xref 健全性）+ テキスト取得', async () => {
    const savedBytes = await buildPdfDocument(corpus.C01.inputBytes, corpus.C01.doc, fontBytes);
    const texts = await extractTextViaPdfjs(savedBytes);
    // pdfjs が返すテキストに入力テキストの部分文字列が含まれることを確認
    // （invisible スペース A-07 由来の余分な空白は許容）
    const allText = texts.flat().join(' ');
    expect(allText).toContain('Hello World');
    expect(allText).toContain('Page Two A');
  }, 30_000);

  it('(e) A-07: 各 BT...ET セグメントで Tj より前に renderMode 3 が設定される（#357）', async () => {
    // #357: A-07 ヘッダの主張（各 BB 末尾 invisible スペース）を content stream レベルで検証
    // 単発マッチ `\b3\s+Tr\b` ではなく「各 BT...ET セグメントで Tj より前に 3 Tr が存在する」
    const savedBytes = await buildPdfDocument(corpus.C01.inputBytes, corpus.C01.doc, fontBytes);
    const contentText = await decodePageContentStream(savedBytes, 0);
    expect(contentText, 'page 0 content stream should be non-empty').not.toBe('');

    const result = assertAllTextSegmentsHaveRenderMode3(contentText);
    expect(result.totalTextSegments, 'C01 page 0 should have text segments').toBeGreaterThan(0);
    expect(
      result.pass,
      `#357 A-07: ${result.failingSegmentCount}/${result.totalTextSegments} BT...ET segments are missing renderMode 3 before Tj`,
    ).toBe(true);
  }, 30_000);

  it('2サイクル耐久: meta が劣化しない（PCT-094 型漂流検出・S-12 shouldUseSavedMeta 経路検証）', async () => {
    // 1 サイクル
    const saved1 = await buildPdfDocument(corpus.C01.inputBytes, corpus.C01.doc, fontBytes);
    const { meta: meta1 } = await reloadBBoxMetaViaPdfjs(saved1);
    expect(meta1, 'cycle 1 meta').not.toBeNull();

    // 2 サイクル: 1サイクル目出力の bboxMeta から再構築し、shouldUseSavedMeta がメタ経路を選ぶことを確認
    // これで「自己出力 → メタ経路ロード → 再保存 → 不変」の本物のループになる（PCT-094 型劣化の検出）
    const pdfjsLib: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdfjsDoc2 = await pdfjsLib.getDocument({
      data: new Uint8Array(saved1),
      disableWorker: true,
      disableFontFace: true,
    }).promise;
    const page0 = await pdfjsDoc2.getPage(1);
    const textContent = await page0.getTextContent();
    const textItems = (textContent.items as Array<any>).filter(
      (item: any) => typeof item.str === 'string' && item.str.trim() !== '',
    );
    const savedMetaPage0 = meta1!['0'];
    // S-12 核心: shouldUseSavedMeta が true を返すこと（メタ経路が選ばれること）
    expect(
      shouldUseSavedMeta(savedMetaPage0 as any, textItems as any),
      'shouldUseSavedMeta must return true for cycle-2 load (S-12 invariant)',
    ).toBe(true);
    try { await pdfjsDoc2.cleanup(); } catch { /* ignore */ }
    try { await pdfjsDoc2.destroy(); } catch { /* ignore */ }

    // 2 サイクル目保存: 1サイクル目の PDF バイト列を入力として再保存
    const saved2 = await buildPdfDocument(saved1, corpus.C01.doc, fontBytes);
    const { meta: meta2 } = await reloadBBoxMetaViaPdfjs(saved2);
    expect(meta2, 'cycle 2 meta').not.toBeNull();

    // meta1 と meta2 が一致（漂流なし）
    assertMetaMatchesInput(corpus.C01, meta2!);
    // page 0 block 0 の bbox が cycle 1 と cycle 2 で一致
    expect(meta2!['0'][0].bbox.x).toBeCloseTo(meta1!['0'][0].bbox.x, 0);
    expect(meta2!['0'][0].bbox.y).toBeCloseTo(meta1!['0'][0].bbox.y, 0);

    // #358: 2サイクル耐久での出現回数検証
    // 2サイクル目保存後も各ブロック文字列がちょうど 1 回出現すること（二重化なし）
    const texts2 = await extractTextViaPdfjs(saved2);
    const allText2 = texts2.flat();
    // 'Hello World' が 2 サイクル後もちょうど 1 回出現（二重化・消失なし）
    const helloCount = allText2.filter((t) => t.includes('Hello World')).length;
    expect(
      helloCount,
      `#358: 'Hello World' should appear exactly once after 2 cycles, got ${helloCount}`,
    ).toBe(1);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// C02: /Rotate 90/180/270 の各ページ（PCT-096 領域）
// ---------------------------------------------------------------------------

describe('PCT-098 C02: /Rotate 90/180/270 各ページ', () => {
  it('(a) 保存→再ロード: テキスト/bbox/writingMode/order が入力と一致', async () => {
    const { reloadedMeta } = await saveAndReload(corpus.C02);
    expect(reloadedMeta.meta, 'meta should not be null').not.toBeNull();
    assertMetaMatchesInput(corpus.C02, reloadedMeta.meta!);
  }, 30_000);

  it('(b) /Rotate 90/180/270 が保持される', async () => {
    const savedBytes = await buildPdfDocument(corpus.C02.inputBytes, corpus.C02.doc, fontBytes);
    const rotations = await readAllRotations(savedBytes);
    expect(rotations[0], 'page 0: rotate=90').toBe(90);
    expect(rotations[1], 'page 1: rotate=180').toBe(180);
    expect(rotations[2], 'page 2: rotate=270').toBe(270);
  }, 30_000);

  it('(c) ページ数・ページ寸法不変', async () => {
    const savedBytes = await buildPdfDocument(corpus.C02.inputBytes, corpus.C02.doc, fontBytes);
    await assertPageDimsUnchanged(savedBytes, corpus.C02);
  }, 30_000);

  it('Worker 経路 (C-03 対称性): rotate=90 ページで main/worker が同一 /Rotate 出力', async () => {
    // C02 のページ 0 (rotate=90) を代表ケースとして Worker 経路を検証 (C-03 対称性)
    const entry = corpus.C02;
    const serializedPages = serializePages(entry.doc);

    const mainBytes = await buildPdfDocument(entry.inputBytes, entry.doc, fontBytes);
    const mainRotate = await readRotate(mainBytes, 0);

    const { savedBytes: workerBytes } = await __handleSavePdfForTest(
      entry.inputBytes,
      { ...entry.doc, pages: serializedPages },
      fontBytes,
      [],
    );
    const workerRotate = await readRotate(workerBytes, 0);

    expect(mainRotate, 'main: page 0 rotate').toBe(90);
    expect(workerRotate, 'worker: page 0 rotate').toBe(90);
    expect(workerRotate, 'main === worker').toBe(mainRotate);

    // meta も一致
    const mainPdfDoc = await PDFDocument.load(new Uint8Array(mainBytes), { throwOnInvalidObject: false });
    const workerPdfDoc = await PDFDocument.load(new Uint8Array(workerBytes), { throwOnInvalidObject: false });
    const mainMeta = readPecoToolBBoxMetaFromPdfDoc(mainPdfDoc);
    const workerMeta = readPecoToolBBoxMetaFromPdfDoc(workerPdfDoc);

    const mainBlocks = mainMeta['0'] as Array<{ text: string; bbox: { x: number; y: number } }> | undefined;
    const workerBlocks = workerMeta['0'] as Array<{ text: string; bbox: { x: number; y: number } }> | undefined;
    expect(mainBlocks).toBeDefined();
    expect(workerBlocks).toBeDefined();
    expect(mainBlocks![0].text).toBe('Rotated90');
    expect(workerBlocks![0].text).toBe('Rotated90');
    expect(workerBlocks![0].bbox.x).toBeCloseTo(mainBlocks![0].bbox.x, 0);
    expect(workerBlocks![0].bbox.y).toBeCloseTo(mainBlocks![0].bbox.y, 0);
  }, 30_000);

  it('2サイクル耐久: /Rotate が劣化しない', async () => {
    const saved1 = await buildPdfDocument(corpus.C02.inputBytes, corpus.C02.doc, fontBytes);
    const saved2 = await buildPdfDocument(saved1, corpus.C02.doc, fontBytes);
    const rotations1 = await readAllRotations(saved1);
    const rotations2 = await readAllRotations(saved2);
    expect(rotations2[0], 'cycle 2 page 0 rotate').toBe(rotations1[0]);
    expect(rotations2[1], 'cycle 2 page 1 rotate').toBe(rotations1[1]);
    expect(rotations2[2], 'cycle 2 page 2 rotate').toBe(rotations1[2]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// C03: 縦書きブロック混在
// ---------------------------------------------------------------------------

describe('PCT-098 C03: 縦書きブロック混在', () => {
  it('(a) 縦書き writingMode と縦長 bbox が再ロード後も保持', async () => {
    const { reloadedMeta } = await saveAndReload(corpus.C03);
    expect(reloadedMeta.meta, 'meta should not be null').not.toBeNull();
    assertMetaMatchesInput(corpus.C03, reloadedMeta.meta!);

    // 縦書きブロックの追加検証: bbox.height > bbox.width
    const vertBlock = reloadedMeta.meta!['0'][1];
    expect(vertBlock.writingMode, 'writingMode vertical').toBe('vertical');
    expect(vertBlock.bbox.height, 'vertical bbox: height > width').toBeGreaterThan(vertBlock.bbox.width);
  }, 30_000);

  it('2サイクル耐久: 縦書き writingMode/bbox が劣化しない', async () => {
    const saved1 = await buildPdfDocument(corpus.C03.inputBytes, corpus.C03.doc, fontBytes);
    const { meta: meta1 } = await reloadBBoxMetaViaPdfjs(saved1);
    const saved2 = await buildPdfDocument(saved1, corpus.C03.doc, fontBytes);
    const { meta: meta2 } = await reloadBBoxMetaViaPdfjs(saved2);

    expect(meta2, 'cycle 2 meta').not.toBeNull();
    const vertBlock1 = meta1!['0'][1];
    const vertBlock2 = meta2!['0'][1];
    expect(vertBlock2.writingMode).toBe('vertical');
    expect(vertBlock2.bbox.height).toBeCloseTo(vertBlock1.bbox.height, 0);
    expect(vertBlock2.bbox.width).toBeCloseTo(vertBlock1.bbox.width, 0);
  }, 60_000);

  it('(e) A-07: 縦書き BT...ET セグメントでも Tj より前に renderMode 3 が設定される（#357）', async () => {
    // #357: C03 縦書きブロックに対して、A-07 の主張を content stream レベルで検証
    // 縦書き各 BT...ET セグメントで Tj より前に 3 Tr が存在することを確認
    const savedBytes = await buildPdfDocument(corpus.C03.inputBytes, corpus.C03.doc, fontBytes);
    const contentText = await decodePageContentStream(savedBytes, 0);
    expect(contentText, 'page 0 content stream should be non-empty').not.toBe('');

    const result = assertAllTextSegmentsHaveRenderMode3(contentText);
    expect(result.totalTextSegments, 'C03 page 0 should have text segments').toBeGreaterThan(0);
    expect(
      result.pass,
      `#357 A-07 (vertical): ${result.failingSegmentCount}/${result.totalTextSegments} BT...ET segments are missing renderMode 3 before Tj`,
    ).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// C04: 既存テキスト層あり（外部 OCR PDF 風）
// ---------------------------------------------------------------------------

describe('PCT-098 C04: 既存テキスト層あり（外部 OCR PDF 風）', () => {
  it('(a) PecoTool メタが保存され再ロードで取得できる', async () => {
    const { reloadedMeta } = await saveAndReload(corpus.C04);
    expect(reloadedMeta.meta, 'meta should not be null').not.toBeNull();
    assertMetaMatchesInput(corpus.C04, reloadedMeta.meta!);
  }, 30_000);

  it('(d) pdfjs で開いてテキストが取れる（xref 健全性）— strip / 二重化検証強化（#358）', async () => {
    const savedBytes = await buildPdfDocument(corpus.C04.inputBytes, corpus.C04.doc, fontBytes);
    const texts = await extractTextViaPdfjs(savedBytes);
    const allText = texts.flat().join(' ');

    // (1) PecoTool が書き込んだ TextBlock テキストがちょうど 1 回出現すること（二重化なし）
    // C04_BLOCK_TEXT_0 = 'Existing text layer content' が 1 回だけ出現することを検証
    const block0Count = texts.flat().filter((t) => t.includes(C04_BLOCK_TEXT_0)).length;
    expect(
      block0Count,
      `#358: '${C04_BLOCK_TEXT_0}' should appear exactly once (no duplication), got ${block0Count}`,
    ).toBe(1);

    // (2) 既存テキスト層（C04_LEGACY_TEXT = 'LEGACY_LAYER_x7'）が出現しないこと（stripTextBlocks 済み）
    // #358: drawText で埋め込んだ既存層が保存後に除去されていることを確認
    expect(
      allText,
      `#358: legacy text '${C04_LEGACY_TEXT}' should be stripped after save`,
    ).not.toContain(C04_LEGACY_TEXT);

    // (3) テキスト総量が非ゼロ（xref 健全性）
    expect(allText.length, 'extracted text should be non-empty').toBeGreaterThan(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// C05: PecoToolBBoxes メタあり（自己保存 PDF 風）—S-12 領域
// ---------------------------------------------------------------------------

describe('PCT-098 C05: PecoToolBBoxes メタあり（自己保存 PDF 風）', () => {
  it('(a) 2サイクル目: メタが 1 サイクル目と等価', async () => {
    // corpus.C05.inputBytes はすでに buildPdfDocument で 1 サイクル保存済み
    const { reloadedMeta: meta1 } = await saveAndReload(corpus.C05);
    expect(meta1.meta, 'cycle 2 meta').not.toBeNull();
    assertMetaMatchesInput(corpus.C05, meta1.meta!);
  }, 30_000);

  it('2サイクル耐久（3サイクル目）: meta が劣化しない（PCT-094 型漂流検出）', async () => {
    const saved2 = await buildPdfDocument(corpus.C05.inputBytes, corpus.C05.doc, fontBytes);
    const saved3 = await buildPdfDocument(saved2, corpus.C05.doc, fontBytes);
    const { meta: meta3 } = await reloadBBoxMetaViaPdfjs(saved3);

    expect(meta3, 'cycle 3 meta').not.toBeNull();
    assertMetaMatchesInput(corpus.C05, meta3!);

    // bbox が cycle 2 と cycle 3 で一致
    const { meta: meta2 } = await reloadBBoxMetaViaPdfjs(saved2);
    expect(meta3!['0'][0].bbox.x).toBeCloseTo(meta2!['0'][0].bbox.x, 0);
    expect(meta3!['0'][0].bbox.y).toBeCloseTo(meta2!['0'][0].bbox.y, 0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// C06: 空ページ含み・ページサイズ混在
// ---------------------------------------------------------------------------

describe('PCT-098 C06: 空ページ含み・ページサイズ混在', () => {
  it('(a) ブロックありページのメタが保持される', async () => {
    const { reloadedMeta } = await saveAndReload(corpus.C06);
    expect(reloadedMeta.meta, 'meta should not be null').not.toBeNull();
    assertMetaMatchesInput(corpus.C06, reloadedMeta.meta!);
  }, 30_000);

  it('(c) ページ数・ページ寸法不変（サイズ混在）', async () => {
    const savedBytes = await buildPdfDocument(corpus.C06.inputBytes, corpus.C06.doc, fontBytes);
    await assertPageDimsUnchanged(savedBytes, corpus.C06);
  }, 30_000);

  it('(d) 空ページを含む PDF を pdfjs で開ける', async () => {
    const savedBytes = await buildPdfDocument(corpus.C06.inputBytes, corpus.C06.doc, fontBytes);
    // xref が壊れていなければ getDocument が成功する
    const texts = await extractTextViaPdfjs(savedBytes);
    expect(texts.length, '3 pages').toBe(3);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// C07: confidence 付きブロック（要確認マーク）—PCT-052 領域
// ---------------------------------------------------------------------------

describe('PCT-098 C07: confidence 付きブロック', () => {
  it('(a) confidence 値が保存→再ロードで保持される', async () => {
    const { reloadedMeta } = await saveAndReload(corpus.C07);
    expect(reloadedMeta.meta, 'meta should not be null').not.toBeNull();

    const meta = reloadedMeta.meta! as Record<string, Array<{ confidence?: number; text: string }>>;
    assertConfidenceMatchesInput(corpus.C07, meta);

    // 具体値の検証
    const page0 = meta['0'];
    expect(page0[0].confidence, 'high confidence').toBeCloseTo(0.95, 5);
    expect(page0[1].confidence, 'low confidence').toBeCloseTo(0.30, 5);
    // confidence なしのブロック: undefined であること
    expect(page0[2].confidence, 'no confidence block should be undefined').toBeUndefined();
  }, 30_000);

  it('Worker 経路: confidence が main と一致（C-03 対称性・PCT-052）', async () => {
    const entry = corpus.C07;
    const serializedPages = serializePages(entry.doc);

    const mainBytes = await buildPdfDocument(entry.inputBytes, entry.doc, fontBytes);
    const mainPdfDoc = await PDFDocument.load(new Uint8Array(mainBytes), { throwOnInvalidObject: false });
    const mainMeta = readPecoToolBBoxMetaFromPdfDoc(mainPdfDoc);

    const { savedBytes: workerBytes } = await __handleSavePdfForTest(
      entry.inputBytes,
      { ...entry.doc, pages: serializedPages },
      fontBytes,
      [],
    );
    const workerPdfDoc = await PDFDocument.load(new Uint8Array(workerBytes), { throwOnInvalidObject: false });
    const workerMeta = readPecoToolBBoxMetaFromPdfDoc(workerPdfDoc);

    const mainBlocks = mainMeta['0'] as Array<{ confidence?: number }>;
    const workerBlocks = workerMeta['0'] as Array<{ confidence?: number }>;

    expect(mainBlocks[0].confidence).toBeCloseTo(0.95, 5);
    expect(workerBlocks[0].confidence).toBeCloseTo(0.95, 5);
    expect(mainBlocks[1].confidence).toBeCloseTo(0.30, 5);
    expect(workerBlocks[1].confidence).toBeCloseTo(0.30, 5);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// descentRatio baseline 検証 — content stream cm 演算子で検出
// ミューテーション実証 ①: descentRatio による cm.f 変化の検証
//
// 背景:
//   bboxMeta のラウンドトリップは入力固定値を保存するため descentRatio の変化を
//   直接検出できない。descentRatio は baseline Y（cm 演算子の f 値）に影響するため
//   content stream を直接検証することで退行を捕まえる。
//
// 重要な制約 (正直な限界):
//   IPAexGothic.ttf の raw descentRatio ≈ 0.1201 (cap=0.12 のほぼ境界値)。
//   cap を 0.5 に改悪しても 0.1201 < 0.5 なので cm.f は変化しない。
//   → cap の境界条件は pdfSaverDescentRatio.test.ts のモックフォントで検証済み。
//   ここでは「cm.f が bbox 座標から合理的な範囲内にあること」を統合的に検証する。
// ---------------------------------------------------------------------------

describe('PCT-098 baseline Y: content stream cm.f が合理的範囲内にある', () => {
  it('C01 横書きブロック: cm.f が bbox.y に基づく許容範囲内にある', async () => {
    // C01 page 0 block 0: bbox.y=50, height=20, pageH=842
    // descentRatio が 0..0.12 の範囲なら:
    //   baselineY の範囲 = [(842-50-20*1.0), (842-50-20*0.88)]
    //                    = [772, 774.4]
    // cm.f がこの範囲（±5）内にあることを確認
    const savedBytes = await buildPdfDocument(corpus.C01.inputBytes, corpus.C01.doc, fontBytes);
    const contentText = await decodePageContentStream(savedBytes, 0);
    const cms = extractCmTranslations(contentText);

    // cm 演算子が存在すること（テキストブロックが書き込まれた証拠）
    expect(cms.length, 'at least one cm operator for text block').toBeGreaterThan(0);

    // bbox.y=50, height=20, pageH=842 ベースの合理的な範囲
    // descentRatio=0 の最大値: 842-50-0 = 792 (上すぎる)
    // descentRatio=1.0 の最小値: 842-50-20 = 772 (下すぎる)
    // cap=0.12 の期待値: 842-50-20*(1-0.12) = 774.4 ± 実フォント誤差
    const BASELINE_MIN = 760;  // これより小さい = descentRatio > 1 = 異常
    const BASELINE_MAX = 800;  // これより大きい = descentRatio < 0 = 異常 (baseline がページ上部に飛ぶ)
    const hasReasonableBaseline = cms.some(
      ({ f }) => f >= BASELINE_MIN && f <= BASELINE_MAX,
    );
    expect(
      hasReasonableBaseline,
      `cm.f should be between ${BASELINE_MIN} and ${BASELINE_MAX}. Got: ${JSON.stringify(cms.slice(0, 5))}`,
    ).toBe(true);
  }, 30_000);

  it('ミューテーション実証 ①: descentRatio が 0 になると cm.f が bbox.y のみで計算されることを確認', async () => {
    // descentRatio=0.1201（正規）時の baseline Y を測定し、期待値を記録する
    // これにより「baselineY が固定で descentRatio=0 になっても差が出ない」誤検出を防ぐ
    const savedBytes = await buildPdfDocument(corpus.C01.inputBytes, corpus.C01.doc, fontBytes);
    const contentText = await decodePageContentStream(savedBytes, 0);
    const cms = extractCmTranslations(contentText);
    expect(cms.length).toBeGreaterThan(0);

    // page 0, block 0: bbox.y=50, height=20, pageH=842
    // descentRatio ≈ 0.1201 → baselineY ≈ 842-50-20*(1-0.1201) ≈ 774.6
    // descentRatio=0 に改悪 → baselineY = 842-50-20 = 772.0 (差 2.6)
    // descentRatio=0.5 に改悪 → baselineY = 842-50-10 = 782.0 (差 7.4)
    // 正規時: 774 以上 776 以下（IPAexGothic の descentRatio 0.1201 に基づく期待値）
    const normalBaselines = cms.filter(({ f }) => f >= 773 && f <= 778);
    // normalBaselines.length >= 1 が要求。
    // descentRatio=0 改悪時: f ≈ 772 → 773 未満で normalBaselines=0 → fail
    // descentRatio=0.5 改悪時: f ≈ 782 → 778 超で normalBaselines=0 → fail
    expect(
      normalBaselines.length,
      `Expected baseline Y near 774-776 (descentRatio ≈ 0.12). Got cms: ${JSON.stringify(cms.slice(0, 5))}`,
    ).toBeGreaterThanOrEqual(1);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// S-13 検証: sanitizeBBoxMetaRecord は all-or-nothing 禁止
// 改悪ミューテーション実証（ミューテーション実証 ②）
// ---------------------------------------------------------------------------

describe('PCT-098 S-13: sanitizeBBoxMetaRecord は不正エントリのみ drop', () => {
  it('破損エントリ 1 件で全ページが null にならない（S-13 不変条件）', async () => {
    // C01 の保存 PDF に不正エントリを 1 件混入して、他のページが保持されることを確認
    const savedBytes = await buildPdfDocument(corpus.C01.inputBytes, corpus.C01.doc, fontBytes);
    const pdfDoc = await PDFDocument.load(new Uint8Array(savedBytes), { throwOnInvalidObject: false });

    // 既存 meta を読んで page 0 に不正エントリを 1 件追加
    const { readPecoToolBBoxMetaFromPdfDoc: readMeta, writePecoToolBBoxMetaToPdfDoc: writeMeta } =
      await import('../../utils/pdfPecoToolMetadata');
    const meta = readMeta(pdfDoc) as Record<string, unknown[]>;

    // 不正エントリ（bbox が欠如）を page 0 に追加
    const page0 = (meta['0'] as unknown[]) ?? [];
    meta['0'] = [...page0, { text: 'corrupt', order: 999 /* bbox なし */ }];
    writeMeta(pdfDoc, meta);
    const corrupted = await pdfDoc.save({ useObjectStreams: false, addDefaultPage: false });

    // 再ロード: loadPecoToolBBoxMeta でサニタイズされる
    const { loadPecoToolBBoxMeta } = await import('../../utils/pdfMetadataLoader');
    const pdfjsLib: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const copy = new Uint8Array(corrupted.byteLength);
    copy.set(corrupted);
    const pdfjsDoc = await pdfjsLib.getDocument({
      data: copy, disableWorker: true, disableFontFace: true,
    }).promise;
    const reloaded = await loadPecoToolBBoxMeta(pdfjsDoc, { bytes: new Uint8Array(corrupted) });
    try { await pdfjsDoc.cleanup(); } catch { /* ignore */ }
    try { await pdfjsDoc.destroy(); } catch { /* ignore */ }

    // S-13: 有効なエントリが残っている（null にならない）
    expect(reloaded, 'valid entries should survive').not.toBeNull();
    // page 0 の有効エントリ（不正な 1 件は除かれ、元の 3 件は残る）
    expect(reloaded!['0'].length, 'valid entries in page 0 (3 valid + 1 corrupt dropped)').toBe(3);
    // page 1 は完全に有効（影響を受けない）
    expect(reloaded!['1'], 'page 1 should be unaffected').toBeDefined();
    expect(reloaded!['1'].length, 'page 1 block count').toBe(3);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// #357 ヘルパー自己テスト: assertAllTextSegmentsHaveRenderMode3 の信頼性検証
// 「わざと 0 Tr を混ぜた合成ストリングでヘルパーが fail を返す」ことを確認
// ---------------------------------------------------------------------------

describe('#357 renderModeHelpers 自己テスト', () => {
  it('正常: すべての BT...ET セグメントで 3 Tr が Tj より前にある場合は pass を返す', () => {
    // 典型的な invisible テキストの content stream 断片
    const validStream = [
      'q',
      'BT',
      '3 Tr',
      '1 0 0 1 50 800 Tm',
      '(Hello) Tj',
      'ET',
      'BT',
      '3 Tr',
      '1 0 0 1 50 750 Tm',
      '(World) Tj',
      'ET',
      'Q',
    ].join('\n');

    const result = assertAllTextSegmentsHaveRenderMode3(validStream);
    expect(result.pass).toBe(true);
    expect(result.totalTextSegments).toBe(2);
    expect(result.failingSegmentCount).toBe(0);
  });

  it('異常: 0 Tr（visible）が混入したセグメントでは fail を返す（ヘルパー検出力の証明）', () => {
    // renderMode 0（visible）が混入した stream — A-07 違反を検出できることを確認
    const invalidStream = [
      'q',
      'BT',
      '3 Tr',
      '1 0 0 1 50 800 Tm',
      '(Invisible) Tj',
      'ET',
      // このセグメントは 0 Tr（visible）なので A-07 違反
      'BT',
      '0 Tr',
      '1 0 0 1 50 750 Tm',
      '(Visible — A-07 violation) Tj',
      'ET',
      'Q',
    ].join('\n');

    const result = assertAllTextSegmentsHaveRenderMode3(invalidStream);
    expect(result.pass).toBe(false);
    expect(result.totalTextSegments).toBe(2);
    expect(result.failingSegmentCount).toBe(1);
    expect(result.failingSegmentIndices).toContain(1);
  });

  it('異常: 3 Tr が Tj より後に書かれた場合も fail を返す（順序チェック）', () => {
    // 3 Tr は存在するが Tj の後に書かれているケース
    const lateRenderModeStream = [
      'q',
      'BT',
      '1 0 0 1 50 800 Tm',
      '(Text first) Tj',
      '3 Tr',
      'ET',
      'Q',
    ].join('\n');

    const result = assertAllTextSegmentsHaveRenderMode3(lateRenderModeStream);
    expect(result.pass).toBe(false);
    expect(result.failingSegmentCount).toBe(1);
  });

  it('異常: 3 Tr が存在しないセグメントでは fail を返す', () => {
    const noRenderModeStream = [
      'q',
      'BT',
      '1 0 0 1 50 800 Tm',
      '(No render mode) Tj',
      'ET',
      'Q',
    ].join('\n');

    const result = assertAllTextSegmentsHaveRenderMode3(noRenderModeStream);
    expect(result.pass).toBe(false);
    expect(result.failingSegmentCount).toBe(1);
  });

  it('BT...ET が存在しない stream では totalTextSegments=0 で pass を返す（空の stream は違反ではない）', () => {
    const emptyStream = 'q Q';
    const result = assertAllTextSegmentsHaveRenderMode3(emptyStream);
    expect(result.pass).toBe(true);
    expect(result.totalTextSegments).toBe(0);
  });
});
