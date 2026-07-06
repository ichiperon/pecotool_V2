/**
 * N-5: 編集後コピペ往復回帰 — テキスト編集 → 再保存 → pdfjs 抽出が「変更後」文字列に
 *      一致し、隣接 BB が癒着しないこと（区切りスペースの維持）を固定する。
 *
 * ## 何を守るテストか
 *   1. 編集差分の往復保持: ブロックのテキストを編集（store の text 上書き / findReplace 相当）
 *      してから保存すると、保存メタ（PecoToolBBoxes JSON）は **変更後** 文字列を lossless に
 *      保持し、原文は残らない。
 *   2. 抽出文字列の一致: 保存 PDF を pdfjs（Acrobat 互換 heuristic）で開いて getTextContent
 *      すると、抽出テキストは **変更後** 文字列を含み、原文は含まない。
 *   3. 隣接区切り: 隣接 2 ブロックは末尾 invisible U+0020（Tw 拡大）で区切られ、語が癒着して
 *      連結（editedA+editedB の連続並び）しない。
 *
 * ## 仕様根拠（誤仕様固定防止）
 *   - 編集差分は store の text 上書きと等価。専用 findReplace ユーティリティは存在しない
 *     ため、本テストは TextBlock.text を直接書き換えて「編集後」を表現する。
 *   - 保存メタは入力 bbox/text を verbatim 保存する（src/utils/pdfSaverCore.ts:1254-1267
 *     `entry.bbox=b.bbox` / text もそのまま）。よって reloadBBoxMetaViaPdfjs（永続 JSON を
 *     読むだけ・helpers/realPdfFixtures.ts:353-375）の text は編集後文字列に一致する。
 *   - 隣接区切りは buildBlockSeparatorOperators（src/utils/pdfSaverCore.ts:915-938）が
 *     各 BB 末尾に renderMode 3（invisible）の U+0020 を Tw 拡大で発行する（issue #100）。
 *     既存回帰 src/__tests__/integration/pdfSaverAcrobatWordBreak.test.ts と同型の検証。
 *   - pdfjs は BT...ET 内 Tj 末尾 0x20 を語境界として扱う（同 #100 テスト :294-336 で実証済み）。
 *
 * ## 注意（取り違え防止 / ground truth C 節）
 *   - reloadBBoxMetaViaPdfjs は永続 JSON を読むだけで座標モデルの正しさは検証しない。
 *     本テストは「編集テキストの lossless 往復」と「抽出での非癒着」を対象とし、cm/baseline の
 *     座標妥当性は別テスト（N-2/N-4）に委ねる。
 *   - 1 ブロック=1 item（pdfjs は連続ランを束ねる）。区切りスペースは別 BT...ET の別 item
 *     として出るため、items 数=ブロック数の前提は置かない。
 *
 * 決定論・実 PDF 非依存（合成 PDF をテスト時生成、IPAexGothic 埋め込み）。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { PDFDocument } from '@cantoo/pdf-lib';
import type { PageData, PecoDocument, TextBlock, WritingMode } from '../../types';
import { buildPdfDocument } from '../../utils/pdfSaver';
import {
  ensurePdfjsEnvForCorpus,
  resetDeterministicCounter,
  loadFontBytesForCorpus,
} from './helpers/goldenCorpus';
import { reloadBBoxMetaViaPdfjs } from './helpers/realPdfFixtures';

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

let fontBytes: ArrayBuffer;

beforeAll(async () => {
  await ensurePdfjsEnvForCorpus();
  fontBytes = loadFontBytesForCorpus();
}, 60_000);

beforeEach(() => {
  resetDeterministicCounter();
});

// ---------------------------------------------------------------------------
// 合成入力: テキスト層なしの空 1 ページ PDF（makeBlankPdf 相当）
// ---------------------------------------------------------------------------
async function makeEmptyPdf(width = 595, height = 842): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([width, height]);
  return pdf.save({ useObjectStreams: false, addDefaultPage: false });
}

function makeBlock(
  id: string,
  text: string,
  bbox: { x: number; y: number; width: number; height: number },
  order: number,
  writingMode: WritingMode = 'horizontal',
): TextBlock {
  return {
    id,
    text,
    originalText: text,
    bbox,
    writingMode,
    order,
    isNew: false,
    isDirty: true,
  };
}

function makeSinglefPageDoc(blocks: TextBlock[], filePath: string): PecoDocument {
  const page: PageData = {
    pageIndex: 0,
    width: 595,
    height: 842,
    textBlocks: blocks,
    isDirty: true,
    thumbnail: null,
  };
  return {
    filePath,
    fileName: filePath,
    totalPages: 1,
    metadata: {},
    pages: new Map<number, PageData>([[0, page]]),
  };
}

/**
 * store の text 上書き / findReplace 相当: 各ブロックの text を置換マップで書き換えた
 * 新しい PecoDocument を返す（編集差分の表現）。bbox/order/writingMode は据え置き。
 */
function applyTextEdit(
  doc: PecoDocument,
  replace: (text: string, order: number) => string,
): PecoDocument {
  const pages = new Map<number, PageData>();
  for (const [pi, page] of doc.pages.entries()) {
    const blocks = page.textBlocks.map((b) => ({
      ...b,
      text: replace(b.text, b.order),
      // originalText は OCR 由来の原文として保持（編集差分の追跡用）。store 挙動と同じ。
      isDirty: true,
    }));
    pages.set(pi, { ...page, textBlocks: blocks, isDirty: true });
  }
  return { ...doc, pages };
}

/** pdfjs で保存 PDF を開き、ページ 0 の全 text item を順序結合して返す。 */
async function extractAllText(savedBytes: Uint8Array): Promise<string> {
  const pdfjsLib: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(savedBytes),
    disableWorker: true,
    disableFontFace: true,
  });
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(1);
  const textContent = await page.getTextContent();
  try { await pdf.cleanup(); } catch { /* ignore */ }
  try { await pdf.destroy(); } catch { /* ignore */ }
  const items = textContent.items as Array<{ str?: string }>;
  return items.map((i) => i.str ?? '').join('');
}

// 原文（OCR 直後）と編集後の対。隣接 2 ブロックを別テキストへ編集する。
// 横書きで bbox を密接させ Acrobat の連結 heuristic を踏ませる（#100 と同条件）。
const ORIG_A = 'スズキイチロウ';
const ORIG_B = 'トウキョウ';
const EDIT_A = 'サトウハナコ';
const EDIT_B = 'オオサカ';

function makeOriginalDoc(): PecoDocument {
  return makeSinglefPageDoc(
    [
      makeBlock('a', ORIG_A, { x: 100, y: 100, width: 140, height: 20 }, 0),
      makeBlock('b', ORIG_B, { x: 241, y: 100, width: 100, height: 20 }, 1),
    ],
    'edit-copy-roundtrip.pdf',
  );
}

const EDIT_MAP: Record<string, string> = { [ORIG_A]: EDIT_A, [ORIG_B]: EDIT_B };

describe('N-5: 編集後コピペ往復（編集差分が往復で保たれ、隣接 BB が癒着しない）', () => {
  it('保存メタは変更後文字列を lossless 保持し、原文は残らない', async () => {
    const empty = await makeEmptyPdf();
    const edited = applyTextEdit(makeOriginalDoc(), (t) => EDIT_MAP[t] ?? t);

    const saved = await buildPdfDocument(empty, edited, fontBytes);
    const { meta } = await reloadBBoxMetaViaPdfjs(saved);

    expect(meta).not.toBeNull();
    const page0 = meta!['0'];
    expect(page0).toHaveLength(2);

    // order でソート済み（reloadBBoxMetaViaPdfjs）→ 変更後文字列に一致
    expect(page0[0].text).toBe(EDIT_A);
    expect(page0[1].text).toBe(EDIT_B);

    // 原文は往復後に残らない（編集差分が保持されている証左）
    expect(page0.map((e) => e.text)).not.toContain(ORIG_A);
    expect(page0.map((e) => e.text)).not.toContain(ORIG_B);
  }, 30_000);

  it('pdfjs 抽出は変更後文字列を含み、隣接 2 ブロックが癒着しない', async () => {
    const empty = await makeEmptyPdf();
    const edited = applyTextEdit(makeOriginalDoc(), (t) => EDIT_MAP[t] ?? t);

    const saved = await buildPdfDocument(empty, edited, fontBytes);
    const allText = await extractAllText(saved);

    // 変更後文字列が抽出される
    expect(allText).toContain(EDIT_A);
    expect(allText).toContain(EDIT_B);

    // 原文は抽出されない（編集が反映されている）
    expect(allText).not.toContain(ORIG_A);
    expect(allText).not.toContain(ORIG_B);

    // 区切りが入り、editedA+editedB の連続並びにならない（語が癒着しない）
    expect(allText).not.toContain(EDIT_A + EDIT_B);
  }, 30_000);

  it('編集往復後も bbox は verbatim 保持される（座標は編集で動かない）', async () => {
    const empty = await makeEmptyPdf();
    const original = makeOriginalDoc();
    const edited = applyTextEdit(original, (t) => EDIT_MAP[t] ?? t);

    const saved = await buildPdfDocument(empty, edited, fontBytes);
    const { meta } = await reloadBBoxMetaViaPdfjs(saved);

    expect(meta).not.toBeNull();
    const page0 = meta!['0'];

    // メタ bbox は入力 bbox を verbatim 保存（pdfSaverCore.ts:1254）。
    // 編集（text 上書き）は座標に影響しない。
    expect(page0[0].bbox).toEqual({ x: 100, y: 100, width: 140, height: 20 });
    expect(page0[1].bbox).toEqual({ x: 241, y: 100, width: 100, height: 20 });
  }, 30_000);
});
