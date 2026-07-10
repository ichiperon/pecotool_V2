/**
 * P1-1 / P1-2 (bug-hunt round1・#367/#392 の同根バグ): byte-preserve と resetDirty の
 * 整合性回帰テスト。
 *
 * 背景:
 *   4a896ae (#367) で導入された resetDirty のリベース処理（保存スナップショットと
 *   参照一致するページの rotation クリア + bbox/width/height リベース）は
 *   「pdfSaverCore が実際に /Rotate を合成して書き込んだ」ことを前提にしていた。
 *
 *   54477fa で undecodable 判定が昇格し、既存 PecoTool BBox stream が decode 不能な
 *   PDF は buildPdfDocumentCore が原本バイトをそのまま返す完全 byte-preserve 短絡
 *   (#392) に合流するようになったが、useFileOperations.ts は保存結果が非 null なら
 *   常に resetDirty(savedPageSnapshots) を呼んでいた。byte-preserve 保存では
 *   rotation 合成も bbox リマップも一切起きていないのに、resetDirty がそれらを実行
 *   すると、メモリ上の bbox/rotation だけがファイルと無関係にズレる (P1-1: 90°汚染)。
 *
 *   また、保存中に別編集が入って savedPageSnapshots と参照不一致になったページは、
 *   rotation が実際に baked されていても resetDirty が一切手を付けていなかった。
 *   ファイルには rotation が焼き込み済みなのに、メモリの rotation フィールドは
 *   古い値のまま残るため、次回保存で「新しい元 /Rotate (既に合成済み) + 残留
 *   rotation」が再度合成され /Rotate がドリフトする (P1-2: #367 と同型のバグが
 *   「参照不一致」経路で再発する)。
 *
 * 修正:
 *   - buildPdfDocumentCore の戻り値に bytePreserved フラグを追加し、
 *     resetDirty(savedPageSnapshots, bytePreserved) で唯一の判定源として伝播する。
 *   - resetDirty は bytePreserved=true のとき何も変更しない。
 *   - 参照不一致でも savedPage.rotation が baked されていれば、livePage (最新編集後)
 *     の bbox/width/height をリベースし、isDirty だけは維持する。
 */
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument, PDFName, PDFNumber, degrees } from '@cantoo/pdf-lib';
import { deflate } from 'pako';
import { buildPdfDocument } from '../../utils/pdfSaver';
import { remapBboxForRotation } from '../../utils/pdfSaverCore';
import { usePecoStore } from '../../store/pecoStore';
import type { PageData, PecoDocument, TextBlock } from '../../types';

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));
// pecoStore.ts は utils/pdfLoader.ts を静的 import する。resetDirty は同期的な純粋な
// set() のみでこれらの IDB ヘルパを呼ばないため、スタブで問題ない
// (pdfSaverRotationComposite.test.ts と同じ理由・同じモック)。
vi.mock('../../utils/pdfLoader', () => ({
  saveTemporaryPageDataBatch: vi.fn().mockResolvedValue(undefined),
  clearTemporaryChanges: vi.fn().mockResolvedValue(undefined),
  getAllTemporaryPageData: vi.fn().mockResolvedValue(new Map()),
  deleteTemporaryPageKeys: vi.fn().mockResolvedValue(undefined),
}));

const PAGE_W = 595;
const PAGE_H = 842;

function arrayBufferFromFile(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

/** /Rotate 指定で 1 ページ PDF を作る (pdfSaverRotationComposite.test.ts と同型)。 */
async function makeRotatedPdf(pageW: number, pageH: number, rotation: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([pageW, pageH]);
  if (rotation !== 0) {
    page.setRotation(degrees(rotation));
  }
  return await pdf.save({ useObjectStreams: false, addDefaultPage: false });
}

async function readRotateDegrees(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes, { throwOnInvalidObject: false });
  const page = doc.getPage(0);
  const rotateEntry = page.node.get(PDFName.of('Rotate'));
  if (rotateEntry instanceof PDFNumber) return rotateEntry.asNumber();
  return 0;
}

/** 入力 PDF に「多重フィルタ」の PecoTool BBox stream を仕込み、decode 不能にする
 * (saveUndecodableMetaPreservation.test.ts と同型の最小再現)。 */
async function makeInputWithUndecodableStream(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([PAGE_W, PAGE_H]);
  const ctx = pdf.context as unknown as {
    register: (obj: unknown) => unknown;
    stream: (bytes: Uint8Array, dict: Record<string, unknown>) => { dict: { set: (k: PDFName, v: unknown) => void } };
    obj: (d: unknown) => unknown;
  };
  const catalog = pdf.catalog as unknown as { set: (k: PDFName, v: unknown) => void };
  const realMeta = JSON.stringify({ '0': [{ x: 10, y: 20, w: 100, h: 30, text: '実OCR' }] });
  const compressed = deflate(new TextEncoder().encode(realMeta));
  const rawStream = ctx.stream(compressed, { Subtype: 'BBoxes' });
  // 多重フィルタチェーン（本バージョン未対応 → decode 不能）
  rawStream.dict.set(
    PDFName.of('Filter'),
    ctx.obj([PDFName.of('FlateDecode'), PDFName.of('FlateDecode')]) as never,
  );
  const streamRef = ctx.register(rawStream);
  catalog.set(PDFName.of('PecoTool'), ctx.obj({ Version: 1, BBoxes: streamRef }) as never);
  return await pdf.save({ useObjectStreams: false, addDefaultPage: false });
}

function makeBlock(overrides: Partial<TextBlock> = {}): TextBlock {
  return {
    id: overrides.id ?? `b-${Math.random().toString(16).slice(2)}`,
    text: 'T',
    originalText: 'T',
    bbox: { x: 50, y: 60, width: 150, height: 22 },
    writingMode: 'horizontal',
    order: 0,
    isNew: false,
    isDirty: true,
    ...overrides,
  };
}

let fontBytes: ArrayBuffer;

beforeAll(() => {
  fontBytes = arrayBufferFromFile(resolve(process.cwd(), 'public/fonts/IPAexGothic.ttf'));
});

describe('P1-1: byte-preserve 保存 (undecodable) では resetDirty が rotation/bbox/isDirty を一切変更しない', () => {
  it('undecodable ソース×回転ページ保存 → bytePreserved=true・resetDirty後もrotation/bbox/isDirtyが不変', async () => {
    const bytes = await makeInputWithUndecodableStream();
    const block = makeBlock({ id: 'p0-edit', bbox: { x: 50, y: 60, width: 150, height: 22 } });
    // rotation:90 のユーザー回転が乗った dirty ページ (byte-preserve では一切焼き込まれない)。
    const page: PageData = {
      pageIndex: 0,
      width: PAGE_W,
      height: PAGE_H,
      textBlocks: [block],
      isDirty: true,
      thumbnail: null,
      rotation: 90,
    };
    const doc: PecoDocument = {
      filePath: 'undecodable-rot.pdf',
      fileName: 'undecodable-rot.pdf',
      totalPages: 1,
      metadata: {},
      pages: new Map<number, PageData>([[0, page]]),
    };

    let bytePreserved: boolean | undefined;
    const saved = await buildPdfDocument(
      bytes, doc, fontBytes, [], undefined, undefined, undefined,
      (bp) => { bytePreserved = bp; },
    );

    // 前提: 完全 byte-preserve (原本と同一バイト・rotation 合成も起きていない)。
    expect(bytePreserved).toBe(true);
    expect(Array.from(saved)).toEqual(Array.from(bytes));
    expect(await readRotateDegrees(saved)).toBe(0);

    // useFileOperations._executeSave 相当の resetDirty 呼び出しをシミュレートする。
    usePecoStore.setState({
      document: doc,
      pageOrder: [0],
      currentPageIndex: 0,
      undoStack: [],
      redoStack: [],
      lastSavedActionIndex: 0,
      isDirty: true,
    } as any);
    const savedPageSnapshots = new Map<number, PageData>([[0, page]]);
    usePecoStore.getState().resetDirty(savedPageSnapshots, bytePreserved);

    const after = usePecoStore.getState().document!.pages.get(0)!;
    // P1-1 の核心: 何も焼き込まれていないので rotation/bbox/isDirty のいずれも不変。
    expect(after.rotation).toBe(90);
    expect(after.isDirty).toBe(true);
    expect(after.textBlocks[0].bbox).toEqual(block.bbox);
    expect(after.width).toBe(PAGE_W);
    expect(after.height).toBe(PAGE_H);
    // ドキュメントレベルの isDirty も維持される (未保存の編集が残っているため)。
    expect(usePecoStore.getState().isDirty).toBe(true);
  }, 30_000);
});

describe('P1-2: 保存スナップショット参照不一致でも baked rotation はリベースされ、次回保存で /Rotate が二重合成されない', () => {
  it('保存中に同ページが再編集されて参照不一致になっても、rotation は baked 分だけリベースされ isDirty は維持される', async () => {
    // 1回目保存: 元 /Rotate=0、userRotation=90。
    const original = await makeRotatedPdf(PAGE_W, PAGE_H, 0);
    const savedBlock = makeBlock({ id: 'b0', text: 'ORIGINAL', bbox: { x: 100, y: 100, width: 200, height: 20 } });
    const savedPage: PageData = {
      pageIndex: 0, width: PAGE_W, height: PAGE_H, textBlocks: [savedBlock],
      isDirty: true, thumbnail: null, rotation: 90,
    };
    const savedDoc: PecoDocument = {
      filePath: 'mismatch.pdf', fileName: 'mismatch.pdf', totalPages: 1, metadata: {},
      pages: new Map<number, PageData>([[0, savedPage]]),
    };
    const saved1 = await buildPdfDocument(original, savedDoc, fontBytes);
    expect(await readRotateDegrees(saved1)).toBe(90);

    // 保存中 (savePDF の await 中) に同じページがユーザーによって再編集された、という
    // 体で「savedPage とは別オブジェクト」の live page を用意する (P1-2 の再現条件)。
    // rotation はまだ触っていない (テキストだけ編集) ので値は savedPage と同じ 90。
    const editedBlock = makeBlock({ id: 'b0', text: 'EDITED_DURING_SAVE', bbox: { x: 120, y: 140, width: 180, height: 24 } });
    const liveEditedPage: PageData = {
      pageIndex: 0, width: PAGE_W, height: PAGE_H, textBlocks: [editedBlock],
      isDirty: true, thumbnail: null, rotation: 90,
    };
    expect(liveEditedPage).not.toBe(savedPage); // 参照不一致であることの前提確認

    usePecoStore.setState({
      document: { ...savedDoc, pages: new Map<number, PageData>([[0, liveEditedPage]]) },
      pageOrder: [0],
      currentPageIndex: 0,
      undoStack: [],
      redoStack: [],
      lastSavedActionIndex: 0,
      isDirty: true,
    } as any);

    // savedPageSnapshots は「保存時点の旧オブジェクト参照」のまま (実運用と同型)。
    // pageOrder 自体は保存中に変化していない (order 一致) シナリオなので orderMatched=true。
    const savedPageSnapshots = new Map<number, PageData>([[0, savedPage]]);
    usePecoStore.getState().resetDirty(savedPageSnapshots, false, true);

    const rebased = usePecoStore.getState().document!.pages.get(0)!;
    // P1-2 の核心: 参照不一致でも rotation は baked 分 (90) だけ差し引かれ、
    // 残り 0 になって undefined へ収束する (次回保存で二重合成させない)。
    expect(rebased.rotation).toBeUndefined();
    // isDirty は維持される (保存に載っていない新しい編集が残っている)。
    expect(rebased.isDirty).toBe(true);
    // bbox は「編集後」の bbox (savedPage の古い bbox ではなく liveEditedPage の bbox) に
    // 対してリベースされる。
    const expectedBbox = remapBboxForRotation(editedBlock.bbox, 0, 90, PAGE_W, PAGE_H);
    expect(rebased.textBlocks[0].bbox).toEqual(expectedBbox);
    expect(rebased.textBlocks[0].text).toBe('EDITED_DURING_SAVE');
    expect(rebased.width).toBe(PAGE_H);
    expect(rebased.height).toBe(PAGE_W);
    expect(usePecoStore.getState().isDirty).toBe(true);

    // 次回保存: rotation が undefined にリベース済みなので、入力 (=saved1、/Rotate=90
    // baked 済み) に対して userRotation=undefined のまま素通しされ、/Rotate は 90 の
    // まま維持される (180 への二重合成が起きないことの直接証拠・#367 冪等テストの
    // 「参照不一致」変種)。
    const doc2: PecoDocument = { ...savedDoc, pages: new Map<number, PageData>([[0, rebased]]) };
    const saved2 = await buildPdfDocument(saved1, doc2, fontBytes);
    expect(await readRotateDegrees(saved2)).toBe(90);
  }, 60_000);
});

describe('HIGH/MEDIUM (bug-hunt round1 最終ゲート・マリン指摘): orderMatched===false のとき rotation/bbox クリア・リベースを丸ごとスキップする', () => {
  it('idx0 の pageA(rotation=90) 保存中に movePage で無回転 pageB が idx0 へ来ても、pageB の rotation/bbox は汚染されない (HIGH の実測再現)', () => {
    const blockA = makeBlock({ id: 'a0', text: 'A', bbox: { x: 10, y: 10, width: 50, height: 20 } });
    const pageA: PageData = {
      pageIndex: 0, width: PAGE_W, height: PAGE_H, textBlocks: [blockA],
      isDirty: true, thumbnail: null, rotation: 90,
    };
    // savedPageSnapshots は保存開始時点 (movePage 前) の idx0 = pageA を指す。
    const savedPageSnapshots = new Map<number, PageData>([[0, pageA]]);

    // 保存中に movePage が走り、無回転の別ページ (pageB, pageA とは無関係) が idx0 に
    // 来た、という体 (pageA は idx1 へ移動)。
    const blockB = makeBlock({ id: 'b0', text: 'B', bbox: { x: 200, y: 300, width: 80, height: 30 } });
    const pageB: PageData = {
      pageIndex: 0, width: PAGE_W, height: PAGE_H, textBlocks: [blockB],
      isDirty: true, thumbnail: null, rotation: undefined,
    };
    expect(pageB).not.toBe(pageA);

    usePecoStore.setState({
      document: {
        filePath: 'reorder-high.pdf', fileName: 'reorder-high.pdf', totalPages: 2, metadata: {},
        pages: new Map<number, PageData>([[0, pageB], [1, { ...pageA, pageIndex: 1 }]]),
      },
      // snapshot 取得時点は [0,1] だったが、保存中の movePage で [1,0] に変わった
      // (= pageOrderMatchesSnapshot=false)。
      pageOrder: [1, 0],
      currentPageIndex: 0,
      undoStack: [],
      redoStack: [],
      lastSavedActionIndex: 0,
      isDirty: true,
    } as any);

    // #437: useFileOperations は pageOrderMatchesSnapshot=false をそのまま orderMatched
    // として resetDirty に渡す。
    usePecoStore.getState().resetDirty(savedPageSnapshots, false, false);

    const afterB = usePecoStore.getState().document!.pages.get(0)!;
    // HIGH の核心: 無関係ページ (pageB) の rotation/bbox/width/height は一切汚染されない
    // (旧ロジックでは normalizeRotation(0 - 90) = 270 が誤注入されていた)。
    expect(afterB.rotation).toBeUndefined();
    expect(afterB.textBlocks[0].bbox).toEqual(blockB.bbox);
    expect(afterB.width).toBe(PAGE_W);
    expect(afterB.height).toBe(PAGE_H);
    // 参照不一致 (pageB !== pageA) なので isDirty は維持される。
    expect(afterB.isDirty).toBe(true);
  });

  it('order不一致時は参照一致ページでも rotation/bbox はクリア・リベースされない (MEDIUM: 次回保存でのpending rotation喪失を防ぐ)', () => {
    const block = makeBlock({ id: 'p0', bbox: { x: 30, y: 40, width: 60, height: 25 } });
    const page: PageData = {
      pageIndex: 0, width: PAGE_W, height: PAGE_H, textBlocks: [block],
      isDirty: true, thumbnail: null, rotation: 90,
    };
    const savedPageSnapshots = new Map<number, PageData>([[0, page]]);

    usePecoStore.setState({
      document: {
        filePath: 'reorder-medium.pdf', fileName: 'reorder-medium.pdf', totalPages: 1, metadata: {},
        pages: new Map<number, PageData>([[0, page]]), // 参照一致 (このページ自体は動いていない)
      },
      pageOrder: [0],
      currentPageIndex: 0,
      undoStack: [],
      redoStack: [],
      lastSavedActionIndex: 0,
      isDirty: true,
    } as any);

    // 他のページの並べ替えにより pageOrder 全体としては snapshot と食い違った
    // (=このページの idx は動いていなくても orderMatched は false)、というシナリオ。
    usePecoStore.getState().resetDirty(savedPageSnapshots, false, false);

    const after = usePecoStore.getState().document!.pages.get(0)!;
    // MEDIUM: #437 は order 不一致時に originalBytesCache を保存前バイトのまま温存し、
    // 次回保存の基準を composite 前の旧 /Rotate に据え置く。ここで rotation/bbox を
    // クリア・リベースすると、次回保存でユーザーの pending rotation を永久に失うため
    // 据え置く。
    expect(after.rotation).toBe(90);
    expect(after.textBlocks[0].bbox).toEqual(block.bbox);
    expect(after.width).toBe(PAGE_W);
    expect(after.height).toBe(PAGE_H);
    // #458: order 不一致時は originalBytesCache が保存前 bytes のままなので、ここで
    // clean にすると次回保存の再描画対象から漏れ、今回の編集が巻き戻る。dirty を維持する。
    expect(after.isDirty).toBe(true);
    expect(usePecoStore.getState().isDirty).toBe(true);
  });
});
