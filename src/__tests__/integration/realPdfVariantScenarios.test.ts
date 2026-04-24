/**
 * REAL PDF バリエーション & E2-3 保存欠損 3 件の回帰固定化テスト。
 *
 * シナリオ:
 *   C3-1: pdf-lib で合成した 1 ページ A4 PDF (text drawn) を pdfjs で
 *         展開→ PecoDocument 化 → savePDF → 再読込 meta が 1:1 一致
 *   C3-3: 実 PDF の先頭 50% だけに切り詰めたバイト列に対し
 *         PDFDocument.load が throw するか、壊れた結果を返しても
 *         savePDF がクラッシュしないことを確認
 *   E2-3a: ba452f5 の off-by-one 回帰。meta.text と BB の対応が維持されるか。
 *          (pdfTextExtractor.ts の textByOrder 廃止に対応)
 *   E2-3b: ba452f5 の BB 移動/リサイズのみ保存漏れ回帰。
 *          page.isDirty だけを見る保存フィルタに対して、block.isDirty のみ
 *          立っていて page.isDirty が false だと保存されない挙動を固定化。
 *   E2-3c: ba452f5 の大容量 meta silent drop 回帰。
 *          大量 (数千単位) の BB を持つ PecoToolBBoxes を再保存し、
 *          safeDecodePdfText が stack overflow を食らわず既存メタが維持される。
 *
 * 実行:
 *   NODE_OPTIONS=--max-old-space-size=6144 npx vitest run \
 *     src/__tests__/integration/realPdfVariantScenarios.test.ts
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { PDFDocument, StandardFonts, PDFName, PDFHexString, PDFString, type PDFDict } from '@cantoo/pdf-lib';

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
import { safeDecodePdfText } from '../../utils/pdfLibSafeDecode';
import type { PecoDocument, PageData, TextBlock } from '../../types';
import {
  findInputPdf,
  outputPath,
  loadFontArrayBuffer,
  ensurePdfjsEnv,
  buildPecoDocumentFromRealPdf,
  reloadBBoxMetaViaPdfjs,
  type BBoxMetaEntry,
} from './helpers/realPdfFixtures';

const REAL_PDF_PATH: string = findInputPdf() ?? '';
const hasRealPdf = REAL_PDF_PATH !== '';

const OUT_C3_1 = outputPath(REAL_PDF_PATH, '_c3_1_synthetic');
const OUT_C3_3 = outputPath(REAL_PDF_PATH, '_c3_3_truncated');
const OUT_E2_3A = outputPath(REAL_PDF_PATH, '_e2_3a_offbyone');
const OUT_E2_3B = outputPath(REAL_PDF_PATH, '_e2_3b_bbox_only');
const OUT_E2_3C = outputPath(REAL_PDF_PATH, '_e2_3c_large_meta');

beforeAll(async () => {
  await ensurePdfjsEnv();
});

beforeEach(() => {
  __setSaveWorkerFactoryForTest(() => null);
  __resetSaveStateForTest();
});

/**
 * pdf-lib で 1 ページ A4 合成 PDF を作成し、Uint8Array として返す。
 * Helvetica で複数行のテキストを描画して、pdfjs が textItems として
 * 最低 2 件以上を取り出せるようにする。
 */
async function buildSynthetic1PagePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]); // A4 (pt)
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Hello World', { x: 50, y: 780, size: 24, font });
  page.drawText('Second Line', { x: 50, y: 740, size: 18, font });
  page.drawText('Third Line', { x: 50, y: 700, size: 14, font });
  return await pdf.save();
}

/**
 * PecoDocument を一枚ものの合成 PDF から組み立てる。
 * buildPecoDocumentFromRealPdf と同じ流儀で pdfjs.getTextContent() を使う。
 */
async function buildPecoDocumentFromSynthetic(
  bytes: Uint8Array,
): Promise<{ doc: PecoDocument; totalBlocks: number; totalPages: number }> {
  return buildPecoDocumentFromRealPdf(bytes, '[synthetic]');
}

/** 期待 BB の簡易コレクト。realPdfFullBBScenarios の collectExpected 相当。 */
function collectExpected(
  doc: PecoDocument,
): Map<number, Array<{ x: number; y: number; width: number; height: number; text: string; writingMode?: string }>> {
  const map = new Map<number, Array<{ x: number; y: number; width: number; height: number; text: string; writingMode?: string }>>();
  for (const [p, pd] of doc.pages.entries()) {
    map.set(
      p,
      pd.textBlocks.map((b) => ({
        x: b.bbox.x,
        y: b.bbox.y,
        width: b.bbox.width,
        height: b.bbox.height,
        text: b.text,
        writingMode: b.writingMode,
      })),
    );
  }
  return map;
}

describe('REAL PDF バリエーション/回帰シナリオ (C3 / E2-3)', () => {
  /**
   * C3-1 は合成 PDF なので REAL PDF が無くても常に走らせる。
   * pdf-lib 生成 → pdfjs 抽出 → savePDF → 再読込 meta 一致 を確認する。
   */
  it('C3-1: 1 ページ synthetic PDF の save/reload で meta が 1:1 一致する', async () => {
    const syntheticBytes = await buildSynthetic1PagePdf();
    writeFileSync(OUT_C3_1.replace('.pdf', '_input.pdf'), syntheticBytes);

    const { doc, totalPages, totalBlocks } = await buildPecoDocumentFromSynthetic(syntheticBytes);
    expect(totalPages).toBe(1);
    // Helvetica で 3 行 drawText した以上、pdfjs は最低 1 件は textItem を返す。
    expect(totalBlocks).toBeGreaterThanOrEqual(1);

    // 全 BB を dirty にして保存対象にする (buildPecoDocumentFromRealPdf 既定で dirty)
    const expected = collectExpected(doc);

    const fontBuf = loadFontArrayBuffer();
    const saved = await savePDF(
      { bytes: new Uint8Array(syntheticBytes) },
      doc,
      fontBuf,
    );
    writeFileSync(OUT_C3_1, saved);

    // pdfjs + loadPecoToolBBoxMeta 経由で再読込
    const { meta, totalPages: reloadedPages } = await reloadBBoxMetaViaPdfjs(new Uint8Array(saved));
    expect(reloadedPages).toBe(1);
    expect(meta).not.toBeNull();

    const page0 = meta!['0'];
    expect(page0).toBeDefined();
    const exp0 = expected.get(0)!;
    expect(page0.length).toBe(exp0.length);

    // 各エントリの text / bbox / writingMode が一致
    for (let i = 0; i < exp0.length; i++) {
      const g = page0[i];
      const e = exp0[i];
      expect(g.text).toBe(e.text);
      expect(g.bbox.x).toBeCloseTo(e.x, 6);
      expect(g.bbox.y).toBeCloseTo(e.y, 6);
      expect(g.bbox.width).toBeCloseTo(e.width, 6);
      expect(g.bbox.height).toBeCloseTo(e.height, 6);
      if (e.writingMode) {
        expect(g.writingMode).toBe(e.writingMode);
      }
    }
  }, 600_000);

  /**
   * C3-3: 実 PDF の先頭 50% だけを切り詰めた破損 PDF。
   * @cantoo/pdf-lib の PDFDocument.load は xref 再構築できない場合に throw するが、
   * throwOnInvalidObject:false + ignoreEncryption:true だと緩やかに読み込む可能性
   * もあるため、どちらの経路でも test が落ちないように両パターンを許容する。
   * savePDF 側は PDFDocument.load に失敗した時点で reject するため、結果的に
   * どちらの場合でも test としては起動時 crash せずに rejection / 成功のいずれか
   * に解決することだけを確認する (strict に「必ず throw する」とはしない:
   * pdf-lib の実装依存で挙動が変わりうるため)。
   */
  it.skipIf(!hasRealPdf)(
    'C3-3: 切り詰め PDF に対し savePDF が graceful に reject するか、少なくとも crash しない',
    async () => {
      const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));
      const truncatedLen = Math.floor(realBytes.length * 0.5);
      const truncated = realBytes.slice(0, truncatedLen);
      writeFileSync(OUT_C3_3.replace('.pdf', '_input.pdf'), truncated);
      console.log(
        `[C3-3] original=${realBytes.length} bytes, truncated=${truncated.length} bytes (50%)`,
      );

      // (a) PDFDocument.load の挙動を観察
      let loadThrew = false;
      let loadSucceeded = false;
      try {
        await PDFDocument.load(new Uint8Array(truncated), {
          throwOnInvalidObject: false,
          ignoreEncryption: true,
          updateMetadata: false,
        });
        loadSucceeded = true;
      } catch (e) {
        loadThrew = true;
        console.log(`[C3-3] PDFDocument.load threw: ${(e as Error).message}`);
      }
      console.log(
        `[C3-3] PDFDocument.load: threw=${loadThrew} succeeded=${loadSucceeded}`,
      );
      // どちらかに必ず解決していること (プロセスが hang しないこと)
      expect(loadThrew || loadSucceeded).toBe(true);

      // (b) savePDF に投げる。通常は load で失敗するので rejection するはず。
      //     失敗時は Error を throw するだけで、プロセス全体は生きていること。
      const fontBuf = loadFontArrayBuffer();
      const dummyDoc: PecoDocument = {
        filePath: '[truncated]',
        fileName: '[truncated]',
        totalPages: 0,
        metadata: {},
        pages: new Map<number, PageData>(),
      };

      let saveThrew = false;
      let saveResult: Uint8Array | null = null;
      try {
        saveResult = await savePDF(
          { bytes: new Uint8Array(truncated) },
          dummyDoc,
          fontBuf,
        );
      } catch (e) {
        saveThrew = true;
        console.log(`[C3-3] savePDF rejected: ${(e as Error).message}`);
      }
      console.log(
        `[C3-3] savePDF: threw=${saveThrew} result=${saveResult ? saveResult.byteLength : 'null'}`,
      );
      // 結果的に解決していればよい (crash していない)
      expect(saveThrew || saveResult !== null).toBe(true);
      if (saveResult) {
        // fallback で通ってしまった場合はバイト列が返ること
        expect(saveResult.byteLength).toBeGreaterThan(0);
        writeFileSync(OUT_C3_3, saveResult);
      }
    },
    600_000,
  );

  /**
   * E2-3a: pdfTextExtractor.loadPage の textByOrder 経由 idx マッチングを廃止した
   * ba452f5 の回帰固定化。
   * 症状: meta.text と BB の対応が 1 件後ろにズレる。
   * 再現ポイント:
   *   - テキストを決定論的に書き換えて保存 (すべての text が unique な値になる)
   *   - 保存後 meta を pdfjs 経由で読み戻すと、各エントリの text が当該 BB の
   *     期待 text と一致する必要がある。
   * もし idx マッチングが復活して pdfjs textItems と savedMeta の件数が食い違うと
   * text が後続ブロックに 1 つズレるため、先頭一致 or 末尾不一致が検出される。
   */
  it.skipIf(!hasRealPdf)(
    'E2-3a: 保存 PDF の meta.text は BB と 1:1 対応し、off-by-one しない',
    async () => {
      const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));
      const { doc, totalPages, totalBlocks } = await buildPecoDocumentFromRealPdf(
        realBytes,
        REAL_PDF_PATH,
      );
      console.log(`[E2-3a] pages=${totalPages}, blocks=${totalBlocks}`);

      // 全ブロックに unique な識別子付きテキストを設定
      for (const [p, pd] of doc.pages.entries()) {
        const newBlocks = pd.textBlocks.map((b, i) => ({
          ...b,
          text: `E23A#p${p}b${i}#${b.text}`,
          originalText: `E23A#p${p}b${i}#${b.text}`,
          isDirty: true,
        }));
        doc.pages.set(p, { ...pd, textBlocks: newBlocks, isDirty: true });
      }

      const expected = collectExpected(doc);

      const fontBuf = loadFontArrayBuffer();
      const saved = await savePDF(
        { bytes: new Uint8Array(realBytes) },
        doc,
        fontBuf,
      );
      writeFileSync(OUT_E2_3A, saved);

      const { meta } = await reloadBBoxMetaViaPdfjs(new Uint8Array(saved));
      expect(meta).not.toBeNull();

      // 各ページ / 各 idx で text が期待と一致すること。
      // off-by-one が起きるとすれば meta[i].text === expected[i-1].text になる。
      let offByOneCount = 0;
      let exactMismatchCount = 0;
      for (const [p, expBlocks] of expected.entries()) {
        const actBlocks = meta![String(p)] ?? [];
        expect(actBlocks.length).toBe(expBlocks.length);
        for (let i = 0; i < expBlocks.length; i++) {
          const exp = expBlocks[i];
          const got = actBlocks[i];
          if (got.text !== exp.text) {
            exactMismatchCount++;
            if (i > 0 && got.text === expBlocks[i - 1].text) offByOneCount++;
            if (exactMismatchCount < 5) {
              console.log(
                `[E2-3a] mismatch p=${p} i=${i} exp="${exp.text}" got="${got.text}"`,
              );
            }
          }
        }
      }
      console.log(
        `[E2-3a] exactMismatchCount=${exactMismatchCount} offByOneCount=${offByOneCount}`,
      );
      expect(offByOneCount).toBe(0);
      expect(exactMismatchCount).toBe(0);
    },
    600_000,
  );

  /**
   * E2-3b: useBlockDragResize が page.isDirty:true を明示的に立てるようになった
   * 修正の回帰固定化。
   * 症状: BB を drag/resize するだけで text を変更しない場合、block.isDirty は
   *       立つが page.isDirty は立たず、savePDF の dirtyPages フィルタで
   *       pageData.isDirty=false → skip され、移動が保存されない。
   *
   * このテストでは pdfSaver の dirtyPages フィルタ (`pageData.isDirty`) を直接
   * 対象に固定化する:
   *   ケースA: 全 block.isDirty=true だが page.isDirty=false → 保存されない (meta 不在)
   *   ケースB: page.isDirty=true にしたら正しく保存される
   */
  it.skipIf(!hasRealPdf)(
    'E2-3b: page.isDirty=false なら保存されず、page.isDirty=true なら保存される',
    async () => {
      const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));
      const { doc: docBase } = await buildPecoDocumentFromRealPdf(
        realBytes,
        REAL_PDF_PATH,
      );

      // ケースA: block.isDirty だけ立つが page.isDirty=false に戻す
      const docCaseA: PecoDocument = {
        ...docBase,
        pages: new Map(
          Array.from(docBase.pages.entries()).map(([p, pd]) => {
            const moved = pd.textBlocks.map((b) => ({
              ...b,
              bbox: { ...b.bbox, x: b.bbox.x + 17, y: b.bbox.y + 23 },
              isDirty: true,
            }));
            return [p, { ...pd, textBlocks: moved, isDirty: false } as PageData];
          }),
        ),
      };

      const fontBuf = loadFontArrayBuffer();
      const savedA = await savePDF(
        { bytes: new Uint8Array(realBytes) },
        docCaseA,
        fontBuf,
      );

      // dirtyPages が空 → meta が書かれない (既存 meta も当然無い元 PDF 前提)。
      // 元 PDF に PecoToolBBoxes が既に付いていた場合はそちらが維持される (消えない)
      // が、BB の移動は反映されていないはず (= 期待と一致しない)。
      const { meta: metaA } = await reloadBBoxMetaViaPdfjs(new Uint8Array(savedA));
      if (metaA !== null) {
        // 既存メタがあった場合: 少なくとも「移動後の座標」にはなっていないこと。
        // 全ブロックがズレているわけではないかもしれないので、一つでも差があれば OK。
        let anyMovedByX17 = false;
        for (const [p, pd] of docCaseA.pages.entries()) {
          const entries = metaA[String(p)] ?? [];
          for (let i = 0; i < Math.min(entries.length, pd.textBlocks.length); i++) {
            const exp = pd.textBlocks[i];
            if (Math.abs(entries[i].bbox.x - exp.bbox.x) < 1e-6) {
              // 期待 (移動後) と一致していれば「保存された」 = 仕様違反
              anyMovedByX17 = true;
              break;
            }
          }
          if (anyMovedByX17) break;
        }
        expect(anyMovedByX17).toBe(false);
      }

      // ケースB: page.isDirty=true に修正したら保存される
      const docCaseB: PecoDocument = {
        ...docBase,
        pages: new Map(
          Array.from(docBase.pages.entries()).map(([p, pd]) => {
            const moved = pd.textBlocks.map((b) => ({
              ...b,
              bbox: { ...b.bbox, x: b.bbox.x + 17, y: b.bbox.y + 23 },
              isDirty: true,
            }));
            return [p, { ...pd, textBlocks: moved, isDirty: true } as PageData];
          }),
        ),
      };

      const savedB = await savePDF(
        { bytes: new Uint8Array(realBytes) },
        docCaseB,
        fontBuf,
      );
      writeFileSync(OUT_E2_3B, savedB);

      const { meta: metaB } = await reloadBBoxMetaViaPdfjs(new Uint8Array(savedB));
      expect(metaB).not.toBeNull();

      // 期待: 各エントリの bbox が +17, +23 されて書き込まれている
      let matchCount = 0;
      let totalCheck = 0;
      for (const [p, pd] of docCaseB.pages.entries()) {
        const entries = metaB![String(p)] ?? [];
        expect(entries.length).toBe(pd.textBlocks.length);
        for (let i = 0; i < pd.textBlocks.length; i++) {
          const exp = pd.textBlocks[i];
          const got = entries[i];
          totalCheck++;
          if (
            Math.abs(got.bbox.x - exp.bbox.x) < 1e-6 &&
            Math.abs(got.bbox.y - exp.bbox.y) < 1e-6
          ) {
            matchCount++;
          }
        }
      }
      console.log(`[E2-3b] caseB match: ${matchCount}/${totalCheck}`);
      // 全件一致を strict 要求 (移動量は 17/23 の unique シフトで衝突しない)
      expect(matchCount).toBe(totalCheck);
    },
    600_000,
  );

  /**
   * E2-3c: safeDecodePdfText 導入による大容量 PecoToolBBoxes silent drop の回帰固定化。
   * 症状: decodeText() が内部で `String.fromCharCode(...bytes)` を spread 呼び出し
   *       しているため、数 MB の hex 文字列で stack overflow → try/catch に
   *       握り潰され existingBBoxMeta = {} として扱われる → 既存メタが消える。
   *
   * 再現方針:
   *   1) 実 PDF の全 BB を大幅に複製して hex 文字列が 2MB 以上になる状況を作る
   *   2) 1 度保存 → その保存済み PDF を入力にもう一度 savePDF
   *   3) 2 回目の savePDF は「既存 meta を読んでマージ」するステップで
   *      safeDecodePdfText が正常に decode できる必要がある
   *   4) 結果 meta の件数が ≒ 1 回目と同じ (silent drop していない) ことを確認
   *
   * フォールバックケース: 全 BB を複製して大量作るには時間がかかるので、
   * 既存 PDF が十分に大きい (e.g. 数万ブロック) なら複製は抑えめ。
   */
  it.skipIf(!hasRealPdf)(
    'E2-3c: 大容量メタを再保存しても既存 meta が silent drop せず保持される',
    async () => {
      const realBytes = new Uint8Array(readFileSync(REAL_PDF_PATH));
      const { doc, totalBlocks, totalPages } = await buildPecoDocumentFromRealPdf(
        realBytes,
        REAL_PDF_PATH,
      );
      console.log(`[E2-3c] orig pages=${totalPages}, blocks=${totalBlocks}`);

      // BB を複製して hex 文字列サイズを肥大化させる。
      // 1 ブロック ~ 150 bytes の JSON として、2MB 超を狙うには ~15000 件必要。
      // 既存 totalBlocks が 15000 未満なら複製倍率を調整する。
      const targetBlocks = 20000;
      const dupFactor = Math.max(1, Math.ceil(targetBlocks / Math.max(totalBlocks, 1)));
      let inflatedBlocks = 0;
      for (const [p, pd] of doc.pages.entries()) {
        const dup: TextBlock[] = [];
        for (let k = 0; k < dupFactor; k++) {
          for (const b of pd.textBlocks) {
            dup.push({
              ...b,
              id: `${b.id}#dup${k}`,
              bbox: { ...b.bbox, x: b.bbox.x + k * 0.001, y: b.bbox.y + k * 0.001 },
              text: `${b.text}#dup${k}`,
              originalText: `${b.text}#dup${k}`,
              order: dup.length,
              isDirty: true,
            });
          }
        }
        doc.pages.set(p, { ...pd, textBlocks: dup, isDirty: true });
        inflatedBlocks += dup.length;
      }
      console.log(
        `[E2-3c] inflated to ${inflatedBlocks} blocks (x${dupFactor})`,
      );

      const fontBuf = loadFontArrayBuffer();

      // 1 回目の保存: 大容量 meta を含む PDF を生成
      const savedOnce = await savePDF(
        { bytes: new Uint8Array(realBytes) },
        doc,
        fontBuf,
      );
      console.log(
        `[E2-3c] first save size=${(savedOnce.byteLength / 1024 / 1024).toFixed(1)} MB`,
      );

      // 1 回目保存結果に PecoToolBBoxes が書かれていることを確認 (+メタサイズ計測)
      const savedDoc = await PDFDocument.load(new Uint8Array(savedOnce), {
        throwOnInvalidObject: false,
        ignoreEncryption: true,
        updateMetadata: false,
      });
      const infoDict = (savedDoc as unknown as { getInfoDict(): PDFDict | undefined }).getInfoDict();
      expect(infoDict).toBeDefined();
      const metaVal = infoDict!.get(PDFName.of('PecoToolBBoxes'));
      expect(metaVal).toBeDefined();
      expect(
        metaVal instanceof PDFHexString || metaVal instanceof PDFString,
      ).toBe(true);

      // safeDecodePdfText が壊れず decode できること = stack overflow 回避の固定化
      const decoded = safeDecodePdfText(metaVal as PDFHexString | PDFString);
      expect(decoded.length).toBeGreaterThan(0);
      const parsed = JSON.parse(decoded) as Record<string, BBoxMetaEntry[]>;
      let countFirst = 0;
      for (const arr of Object.values(parsed)) countFirst += arr.length;
      console.log(`[E2-3c] first-save meta block count=${countFirst}`);
      expect(countFirst).toBe(inflatedBlocks);

      // 2 回目の保存: 何も編集していない (page.isDirty=false) が、
      // pdfSaver は existingBBoxMeta を読み取って維持する経路を通る。
      // safeDecodePdfText がないと decodeText() で stack overflow → meta 消失。
      const docPass2: PecoDocument = {
        ...doc,
        pages: new Map(
          Array.from(doc.pages.entries()).map(([p, pd]) => [
            p,
            { ...pd, isDirty: false } as PageData,
          ]),
        ),
      };
      const savedTwice = await savePDF(
        { bytes: new Uint8Array(savedOnce) },
        docPass2,
        fontBuf,
      );
      writeFileSync(OUT_E2_3C, savedTwice);

      const { meta: metaAfter } = await reloadBBoxMetaViaPdfjs(new Uint8Array(savedTwice));
      expect(metaAfter).not.toBeNull();
      let countAfter = 0;
      for (const arr of Object.values(metaAfter!)) countAfter += arr.length;
      console.log(`[E2-3c] second-save meta block count=${countAfter}`);
      // silent drop していないこと: 件数が維持される
      expect(countAfter).toBe(countFirst);
    },
    600_000,
  );
});
