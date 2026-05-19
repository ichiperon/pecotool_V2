/**
 * Issue #82: cleanFormXObjectsInResources で visited Set を全ページ共有しているため、
 *   将来「Form XObject に per-page 処理を入れたい」変更で回帰しうる。
 *
 * 修正 (今回 #82):
 *   - 不変条件 (stripTextBlocks の冪等性, cleanContentStream の bytesEqual no-op,
 *     visited.add() が recurse 手前にあること) をコメントで明示。
 *
 * 本テストは将来回帰を catch するため以下を assert する:
 *   1. 複数ページが同じ Form XObject ref を共有していても、保存後も「共有関係」は壊れない
 *      (両ページが同じ ref を指したまま)。
 *   2. 共有 Form XObject の BT...ET は 1 回だけ strip される
 *      (出力 stream が原本と異なり、再 inflate して BT/ET が消えている)。
 *   3. saver 実行中の `updateContents` 呼び出しが Form XObject ごとに 1 回まで
 *      (sharedVisitedFormRefs が機能している証拠。同じ ref で複数回 deflate しない)。
 *
 * シナリオ:
 *   - 2 ページの PDF を作成
 *   - 単一の Form XObject (BT (leakage) Tj ET を含む) を作って両ページの Resources.XObject に
 *     同じ ref で登録
 *   - 両ページに dummy dirty TextBlock を入れて saver を起動
 *   - 保存後に Form XObject を再 inflate して「leakage」が消えている事を確認
 *   - 両ページとも同じ Form XObject ref を共有したまま
 */
import { describe, it, expect, vi } from 'vitest';
import { PDFDocument, PDFDict, PDFName, PDFRawStream, PDFRef } from '@cantoo/pdf-lib';
import { inflate } from 'pako';
import { buildPdfDocument } from '../../utils/pdfSaver';
import type { PageData, PecoDocument, TextBlock } from '../../types';

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

const SHARED_FORM_XOBJECT_NAME = PDFName.of('FmSharedPeco');

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function getOrCreatePageResources(doc: PDFDocument, page: ReturnType<PDFDocument['getPage']>): PDFDict {
  const existing = (page.node as unknown as { Resources?: () => PDFDict | undefined }).Resources?.();
  if (existing) return existing;
  const resources = doc.context.obj({}) as PDFDict;
  page.node.set(PDFName.of('Resources'), resources);
  return resources;
}

function getOrCreateXObjectDict(doc: PDFDocument, resources: PDFDict): PDFDict {
  const existing = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (existing) return existing;
  const xObjects = doc.context.obj({}) as PDFDict;
  resources.set(PDFName.of('XObject'), xObjects);
  return xObjects;
}

/**
 * 2 ページ PDF を作成し、両ページに同じ Form XObject (BT (leak-shared) Tj ET) を共有させる。
 */
async function makePdfWithSharedFormXObject(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page1 = pdf.addPage([595, 842]);
  const page2 = pdf.addPage([595, 842]);

  // BT...ET を含む共有 Form XObject (Subtype /Form)
  const formContent = latin1Bytes(
    [
      'q',
      'BT',
      '/F1 12 Tf',
      '(leak-shared) Tj',
      'ET',
      'Q',
    ].join('\n'),
  );
  const formStream = pdf.context.flateStream(formContent, {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [0, 0, 200, 200],
    Resources: {},
  });
  const formRef = pdf.context.register(formStream);

  // 両ページの Resources.XObject に同じ ref で登録
  const r1 = getOrCreatePageResources(pdf, page1);
  getOrCreateXObjectDict(pdf, r1).set(SHARED_FORM_XOBJECT_NAME, formRef);
  const r2 = getOrCreatePageResources(pdf, page2);
  getOrCreateXObjectDict(pdf, r2).set(SHARED_FORM_XOBJECT_NAME, formRef);

  // 両ページ Contents に Do operator (共有 Form XObject を呼ぶ) を入れる
  const doStream1 = pdf.context.register(pdf.context.flateStream(latin1Bytes('q\n/FmSharedPeco Do\nQ')));
  page1.node.set(PDFName.of('Contents'), pdf.context.obj([doStream1]));
  const doStream2 = pdf.context.register(pdf.context.flateStream(latin1Bytes('q\n/FmSharedPeco Do\nQ')));
  page2.node.set(PDFName.of('Contents'), pdf.context.obj([doStream2]));

  return await pdf.save({ useObjectStreams: false, addDefaultPage: false });
}

function makeDummyBlock(pageIndex: number): TextBlock {
  return {
    id: `b-${pageIndex}`,
    text: '',  // 空: フォント embed を発動させない
    originalText: '',
    bbox: { x: 0, y: 0, width: 0, height: 0 },
    writingMode: 'horizontal',
    order: 0,
    isNew: false,
    isDirty: true,
  };
}

function makeBothPagesDirtyDoc(): PecoDocument {
  const page0: PageData = {
    pageIndex: 0,
    width: 595,
    height: 842,
    textBlocks: [makeDummyBlock(0)],
    isDirty: true,
    thumbnail: null,
  };
  const page1: PageData = {
    pageIndex: 1,
    width: 595,
    height: 842,
    textBlocks: [makeDummyBlock(1)],
    isDirty: true,
    thumbnail: null,
  };
  return {
    filePath: 'shared-form.pdf',
    fileName: 'shared-form.pdf',
    totalPages: 2,
    metadata: {},
    pages: new Map([[0, page0], [1, page1]]),
  };
}

/** ページ N の Resources.XObject から共有 Form XObject ref を取り出す */
function getSharedFormRef(doc: PDFDocument, pageIndex: number): string | null {
  const page = doc.getPage(pageIndex);
  const resources = (page.node as unknown as { Resources?: () => PDFDict | undefined }).Resources?.();
  const xObjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (!xObjects) return null;
  const ref = xObjects.get(SHARED_FORM_XOBJECT_NAME);
  if (!(ref instanceof PDFRef)) return null;
  return ref.toString();
}

/** ref 経由で Form XObject の decoded contents を取得する */
function decodeFormContent(doc: PDFDocument, refString: string): string | null {
  // ref string を逆引きするのは pdf-lib では辛いので、page 0 の SHARED_FORM_XOBJECT_NAME から取り直す。
  // 本テストは shared ref を assert したいので、同じ ref が両ページにあることは別 assert で担保する。
  const page = doc.getPage(0);
  const resources = (page.node as unknown as { Resources?: () => PDFDict | undefined }).Resources?.();
  const xObjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  const ref = xObjects?.get(SHARED_FORM_XOBJECT_NAME);
  if (!ref || ref.toString() !== refString) return null;
  const form = doc.context.lookup(ref);
  if (!(form instanceof PDFRawStream)) return null;
  const filter = form.dict.lookup(PDFName.of('Filter'));
  const raw = form.getContents();
  if (filter instanceof PDFName && filter.asString() === '/FlateDecode') {
    try { return new TextDecoder('latin1').decode(inflate(raw)); } catch { return null; }
  }
  if (!filter) return new TextDecoder('latin1').decode(raw);
  return null;
}

describe('Issue #82: shared Form XObject visited Set invariant', () => {
  it('2 ページ共有の Form XObject 内 BT...ET が strip 1 回で全ページ分解消され、共有関係は壊れない', async () => {
    const original = await makePdfWithSharedFormXObject();

    // sanity: 元 PDF では 両ページが同じ Form XObject ref を共有
    const originalDoc = await PDFDocument.load(original, { throwOnInvalidObject: false });
    const origRef0 = getSharedFormRef(originalDoc, 0);
    const origRef1 = getSharedFormRef(originalDoc, 1);
    expect(origRef0).not.toBeNull();
    expect(origRef0).toBe(origRef1);

    // sanity: 元 Form XObject に leak-shared テキストが入っている
    const origContent = decodeFormContent(originalDoc, origRef0!);
    expect(origContent).not.toBeNull();
    expect(origContent).toContain('(leak-shared) Tj');
    expect(origContent).toContain('BT');
    expect(origContent).toContain('ET');

    // 保存実行 (両ページ dirty)
    const saved = await buildPdfDocument(original, makeBothPagesDirtyDoc());
    const savedDoc = await PDFDocument.load(new Uint8Array(saved), { throwOnInvalidObject: false });

    // 保存後も両ページは同じ Form XObject ref を共有していること (壊れていない)
    const savedRef0 = getSharedFormRef(savedDoc, 0);
    const savedRef1 = getSharedFormRef(savedDoc, 1);
    expect(savedRef0).not.toBeNull();
    expect(savedRef0).toBe(savedRef1);

    // Form XObject 内 BT...ET が 1 回で削除されていること
    const savedContent = decodeFormContent(savedDoc, savedRef0!);
    expect(savedContent).not.toBeNull();
    expect(savedContent).not.toContain('(leak-shared)');
    expect(savedContent).not.toContain('BT');
    expect(savedContent).not.toContain('ET');
    expect(savedContent).not.toContain('Tj');
  }, 60_000);

  it('sharedVisitedFormRefs により共有 Form XObject の updateContents は 1 回だけ呼ばれる', async () => {
    const original = await makePdfWithSharedFormXObject();

    // PDFRawStream.prototype.updateContents を spy する。
    // sharedVisitedFormRefs が機能していれば共有 Form XObject に対する書込は 1 回まで。
    const sandboxDoc = await PDFDocument.load(original, { throwOnInvalidObject: false });
    const sampleForm = sandboxDoc.context.lookup(getSharedFormRef(sandboxDoc, 0)!.split(' ')[0] as never);
    void sampleForm; // sandbox 用 (型エラー回避)

    const proto = (PDFRawStream.prototype as unknown as {
      updateContents: (bytes: Uint8Array) => void;
    });
    const orig = proto.updateContents;
    let formUpdateCalls = 0;

    proto.updateContents = function patchedUpdateContents(this: PDFRawStream, bytes: Uint8Array) {
      // Form XObject だけカウント
      const subtype = this.dict.lookup(PDFName.of('Subtype'));
      if (subtype instanceof PDFName && subtype.asString() === '/Form') {
        formUpdateCalls += 1;
      }
      return orig.call(this, bytes);
    };

    try {
      await buildPdfDocument(original, makeBothPagesDirtyDoc());
      // 共有 Form XObject は 1 つしかない → updateContents は最大 1 回
      // (両ページが ref を共有しているのに 2 回呼ばれていたら visited が機能していない)
      expect(
        formUpdateCalls,
        `共有 Form XObject への updateContents 呼び出しは 1 回までのはず (実際: ${formUpdateCalls})`,
      ).toBeLessThanOrEqual(1);
      expect(formUpdateCalls).toBe(1); // 実際に 1 回 strip された (BT...ET があったので)
    } finally {
      proto.updateContents = orig;
    }
  }, 60_000);
});
