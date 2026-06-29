/**
 * N-2: ドラッグ移動後の bbox が「保存メタ」と「描画 Tm/transform」の両方へ反映される回帰
 *
 * 目的:
 *   useBlockDragResize 由来で textBlocks[].bbox を上書きした「移動後ドキュメント」を保存したとき、
 *   (a) 永続 PecoToolBBoxes メタが新座標を verbatim で持つ
 *   (b) pdfjs で再抽出した content-stream の transform（=描画 Tm）も新座標を指す
 *   ことを検証する。旧座標のまま描画されていたら赤。
 *
 * なぜ両系統を見るか（誤仕様固定の回避）:
 *   reloadBBoxMetaViaPdfjs は「永続 JSON メタを読むだけ」で、保存時の入力 bbox を
 *   そのまま返す（pdfSaverCore.ts:1254-1267 `entry.bbox = b.bbox`）。メタ一致だけでは
 *   cm/baseline の描画バグを素通しする。よって描画系の真実は pdfjs getTextContent の
 *   transform（PDF user space・/Rotate 前）から直接読む。
 *
 * 座標モデル根拠（横書き・合成 BBox (x,y,w,h)）:
 *   保存式: pdfSaverCore.ts:1447-1454
 *     baselineY = vh - bbox.y - bbox.height*(1 - descentRatio)
 *     合成: pushGraphicsState, ...rotationCm, translate(bbox.x, baselineY), scale(sx,sy)
 *   rotationCm: getRotationCm pdfSaverCore.ts:566-583（点 (X,Y)→(a·X+c·Y+e, b·X+d·Y+f)）
 *     R=0:   []                     恒等
 *     R=90:  cm(0,1,-1,0,pageW,0)   (X,Y)→(pageW-Y, X)
 *     R=180: cm(-1,0,0,-1,pageW,pageH) (X,Y)→(pageW-X, pageH-Y)
 *     R=270: cm(0,-1,1,0,0,pageH)   (X,Y)→(Y, pageH-X)
 *   pageW/pageH は page.getSize()（/Rotate 前・常に 595×842）。
 *
 *   ラン始点（advance=0）= translate 後の原点。transform[4]/[5] へ写すと
 *   （ground truth A-1 実測で確認・x100 y100 w200 h20, W595 H842）:
 *     R=0:   tx4 = x,               tx5 = H - y - h(1-dr)
 *     R=90:  tx4 = y + h(1-dr),     tx5 = x
 *     R=180: tx4 = W - x,           tx5 = y + h(1-dr)
 *     R=270: tx4 = W - y - h(1-dr), tx5 = H - x
 *
 *   ★ フォント非依存な「クリーン成分」（descentRatio に依存しない方）を移動反映アンカーに使う:
 *     R=0:   transform[4] === bbox.x           （実測 t4=100.00）
 *     R=90:  transform[5] === bbox.x           （実測 t5=100.00）
 *     R=180: transform[4] === pageW - bbox.x   （実測 t4=495.00 = 595-100）
 *     R=270: transform[5] === pageH - bbox.x   （実測 t5=742.00 = 842-100）
 *   いずれも bbox.x のみの関数で決定的・フォント無関係。これが「移動した x が描画 Tm に
 *   流れたか」を厳密に固定する。旧 x が漏れていればこのアンカーは旧値側にズレて赤。
 *
 * メタ verbatim 根拠: pdfSaverCore.ts:1254-1267（既存 goldenMaster は toBeCloseTo(_,0)＝±0.5
 *   ではなく toEqual で完全一致できる verbatim）。
 *
 * house-style: goldenMaster.test.ts:19-52（pdf.worker mock / pdfLoader stub / ensurePdfjsEnvForCorpus /
 *   resetDeterministicCounter / loadFontBytesForCorpus）に準拠。フォントは IPAexGothic 固定
 *   （goldenCorpus.ts:27,30）で descentRatio cap 0.12（pdfSaverCore.ts:736）。
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { PDFDocument, degrees } from '@cantoo/pdf-lib';

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));
// pdfLoader は Tauri/DOM 依存が重いため stub する（本テストは直接使わない）
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
import {
  ensurePdfjsEnvForCorpus,
  resetDeterministicCounter,
  loadFontBytesForCorpus,
} from './helpers/goldenCorpus';
import {
  reloadBBoxMetaViaPdfjs,
  buildPecoDocumentFromRealPdf,
} from './helpers/realPdfFixtures';
import type { PecoDocument, PageData, TextBlock, WritingMode } from '../../types';

// ---------------------------------------------------------------------------
// 定数: PDF user-space ページ寸法（/Rotate 前・getSize() 由来）
// ---------------------------------------------------------------------------
const PAGE_W = 595;
const PAGE_H = 842;

type Rot = 0 | 90 | 180 | 270;
interface Bbox { x: number; y: number; width: number; height: number }

// 旧座標（ドラッグ前）と移動後座標（ドラッグ後）。
// 両者の x 差は 200・y 差は 300（baseline shift ≲ 20pt より十分大きく、混同を検出可能）。
// 全回転の viewport（595×842 / 842×595）に収まる範囲に配置。
const OLD_BBOX: Bbox = { x: 100, y: 100, width: 200, height: 20 };
const MOVED_BBOX: Bbox = { x: 300, y: 400, width: 200, height: 20 };

let fontBytes: ArrayBuffer;

beforeAll(async () => {
  await ensurePdfjsEnvForCorpus();
  fontBytes = loadFontBytesForCorpus();
}, 60_000);

beforeEach(() => {
  resetDeterministicCounter();
});

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

/** /Rotate=R の 1 ページ空 PDF（テキスト層なし）を生成 */
async function makeBlankRotatedPdf(rotate: Rot): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([PAGE_W, PAGE_H]);
  if (rotate !== 0) page.setRotation(degrees(rotate));
  return pdf.save({ useObjectStreams: false, addDefaultPage: false });
}

/** viewport 寸法（R=90/270 で swap）。bbox は viewport 座標系で与える前提 */
function viewportDims(rotate: Rot): { w: number; h: number } {
  return rotate === 90 || rotate === 270
    ? { w: PAGE_H, h: PAGE_W }
    : { w: PAGE_W, h: PAGE_H };
}

/** 横書き 1 ブロックの移動後 PecoDocument を組む（useBlockDragResize の出力＝bbox 上書きと等価） */
function makeMovedDoc(rotate: Rot, bbox: Bbox, text: string): PecoDocument {
  const vp = viewportDims(rotate);
  const block: TextBlock = {
    id: 'p0-b0',
    text,
    originalText: text,
    bbox: { ...bbox },
    writingMode: 'horizontal' as WritingMode,
    order: 0,
    isNew: false,
    isDirty: true,
  };
  const page: PageData = {
    pageIndex: 0,
    width: vp.w,
    height: vp.h,
    textBlocks: [block],
    isDirty: true,
    thumbnail: null,
    isTextExtracted: true,
  };
  const pages = new Map<number, PageData>([[0, page]]);
  return {
    filePath: `move_r${rotate}.pdf`,
    fileName: `move_r${rotate}.pdf`,
    totalPages: 1,
    metadata: {},
    pages,
  };
}

/** 保存済み PDF・ページ0 の最初の非空テキスト item の transform を返す（PDF user space） */
async function readFirstTextTransform(savedBytes: Uint8Array): Promise<number[]> {
  const pdfjsLib: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const copy = new Uint8Array(savedBytes.byteLength);
  copy.set(savedBytes);
  const task = pdfjsLib.getDocument({ data: copy, disableWorker: true, disableFontFace: true });
  const doc = await task.promise;
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  // 末尾 invisible U+0020 セパレータ（buildBlockSeparatorOperators・別 BT...ET）は
  // str.trim()==='' で除外し、本文ランの item を取る（buildPecoDocumentFromRealPdf:192-194 と同型）
  const items = (content.items as Array<any>).filter(
    (it) => typeof it.str === 'string' && it.str.trim() !== '',
  );
  try { await doc.cleanup(); } catch { /* ignore */ }
  try { await doc.destroy(); } catch { /* ignore */ }
  if (items.length === 0) throw new Error('no visible text item extracted');
  return items[0].transform as number[];
}

/**
 * 回転ごとの「クリーン成分」（bbox.x のみで決まる descentRatio 非依存値）を返す。
 *   R=0:   transform[4] === x
 *   R=90:  transform[5] === x
 *   R=180: transform[4] === pageW - x
 *   R=270: transform[5] === pageH - x
 */
function cleanAnchor(rotate: Rot, transform: number[]): { actual: number; expectedForX: (x: number) => number } {
  switch (rotate) {
    case 0:   return { actual: transform[4], expectedForX: (x) => x };
    case 90:  return { actual: transform[5], expectedForX: (x) => x };
    case 180: return { actual: transform[4], expectedForX: (x) => PAGE_W - x };
    case 270: return { actual: transform[5], expectedForX: (x) => PAGE_H - x };
  }
}

// ---------------------------------------------------------------------------
// テスト本体
// ---------------------------------------------------------------------------

describe('N-2: ドラッグ移動後 bbox が 保存メタ / 描画 Tm の両方へ反映される', () => {
  const ROTATIONS: Rot[] = [0, 90, 180, 270];

  for (const R of ROTATIONS) {
    it(`R=${R}: (a)メタ verbatim=移動後座標 / (b)transform クリーン成分=移動後 x（旧座標なら赤）`, async () => {
      const input = await makeBlankRotatedPdf(R);
      const text = `Moved_R${R}`;
      const doc = makeMovedDoc(R, MOVED_BBOX, text);

      const saved = await buildPdfDocument(input, doc, fontBytes);

      // --- (a) 永続メタは移動後 bbox を verbatim 保持 ---
      const { meta } = await reloadBBoxMetaViaPdfjs(saved);
      expect(meta).not.toBeNull();
      const entry = meta!['0'][0];
      expect(entry.bbox).toEqual(MOVED_BBOX);       // 完全一致（pdfSaverCore.ts:1254）
      expect(entry.bbox).not.toEqual(OLD_BBOX);     // 旧座標が残っていれば赤
      expect(entry.text).toBe(text);

      // --- (b) 描画 transform のクリーン成分が移動後 x を指す ---
      const tx = await readFirstTextTransform(saved);
      const { actual, expectedForX } = cleanAnchor(R, tx);
      const expectedMoved = expectedForX(MOVED_BBOX.x);
      const expectedOld = expectedForX(OLD_BBOX.x);

      // 移動後 x 由来の値に一致（±0.5）。sx=w/textWidth により厳密。
      expect(actual).toBeCloseTo(expectedMoved, 0);
      // 旧 x 由来の値（差 200pt）からは明確に乖離 → 旧座標漏れを検出
      expect(Math.abs(actual - expectedOld)).toBeGreaterThan(100);
    }, 30_000);
  }

  it('R=0: pdfjs 再抽出 viewport bbox も移動後座標（旧座標から乖離）', async () => {
    // buildPecoDocumentFromRealPdf は transform→viewport bbox へ戻す（realPdfFixtures.ts:196-235）。
    // R=0 は viewport=PDF user space（convertToViewportPoint(X,Y)=(X,H-Y)）なので、
    // x/width はクリーンに往復する（y は baseline shift+thickness 分ずれるため別許容）。
    const input = await makeBlankRotatedPdf(0);
    const doc = makeMovedDoc(0, MOVED_BBOX, 'Moved_reextract');

    const saved = await buildPdfDocument(input, doc, fontBytes);
    const re = await buildPecoDocumentFromRealPdf(saved, 'move_r0.pdf');
    const rb = re.doc.pages.get(0)!.textBlocks[0].bbox;

    // x/width は厳密往復（ground truth A-1 R=0 + viewport 変換）
    expect(rb.x).toBeCloseTo(MOVED_BBOX.x, 0);
    expect(rb.width).toBeCloseTo(MOVED_BBOX.width, 0);
    // 旧座標から乖離（x 差 200）
    expect(Math.abs(rb.x - OLD_BBOX.x)).toBeGreaterThan(100);
    // y も移動後帯（旧 y=100 から大きく離れる。shift+thickness ≲ 40pt 許容）
    expect(Math.abs(rb.y - MOVED_BBOX.y)).toBeLessThan(40);
    expect(Math.abs(rb.y - OLD_BBOX.y)).toBeGreaterThan(150);
  }, 30_000);
});
