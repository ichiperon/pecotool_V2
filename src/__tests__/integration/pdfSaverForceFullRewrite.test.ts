/**
 * forceFullRewrite エスケープハッチの回帰テスト。
 *
 * 背景: buildPdfDocumentCore は「無編集・デフォルト順・PecoTool メタ無し・孤児ゼロ」の
 * とき入力バイトをそのまま返す no-op 短絡を持つ（Acrobat の dirty 判定回避）。
 * OCR 設定の forceFullRewriteOnSave（既定 OFF）が ON のとき、この短絡を貫通して
 * 通常パス（sweepNonDirtyPage 等のクリーンアップ）を必ず通す。
 *
 * - OFF（既定 / 未指定）: 無傷ファイルはバイト温存（短絡維持）= RC 保証ライン「保存の正しさ」を不変に保つ。
 * - ON: 短絡を貫通して再書き出し（バイトが変わる）。
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument } from '@cantoo/pdf-lib';
import { buildPdfDocumentCore } from '../../utils/pdfSaverCore';
import type { SerializedPageData } from '../../utils/pdfWorkerTypes';

/**
 * PecoTool メタを持たず、孤児オブジェクトも無い「無傷の素な PDF」を生成する。
 * この条件だと OFF では no-op 短絡が発動して原本バイトがそのまま返る。
 */
async function makePristinePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  page.drawRectangle({ x: 10, y: 10, width: 60, height: 40 });
  // Acrobat 7 互換のため通常保存は useObjectStreams:false（旧形式 xref）。
  return await doc.save({ useObjectStreams: false });
}

const emptyPages = () => new Map<number, SerializedPageData>();

describe('buildPdfDocumentCore — forceFullRewrite エスケープハッチ', () => {
  it('OFF（既定・未指定）: 無傷ファイルはバイト温存される（no-op 短絡が維持される）', async () => {
    const original = await makePristinePdf();
    const { savedBytes } = await buildPdfDocumentCore(
      original,
      { totalPages: 1, pages: emptyPages() },
      undefined,
      [],
      {},
    );
    // 短絡発動時は originalPdfBytes をそのまま返す（参照同一）。
    expect(savedBytes).toBe(original);
  });

  it('ON: forceFullRewrite=true なら短絡を貫通して再書き出しする（バイトが変わる）', async () => {
    const original = await makePristinePdf();
    const { savedBytes } = await buildPdfDocumentCore(
      original,
      { totalPages: 1, pages: emptyPages() },
      undefined,
      [],
      { options: { compression: 'none', forceFullRewrite: true } },
    );
    // 短絡発動時のみ originalPdfBytes（原本参照）をそのまま返す。ここで別参照になっている
    // こと自体が「短絡を貫通して通常パス（pdf-lib save 経由）を通った」決定的な証跡。
    // ※素な PDF は再シリアライズで偶然バイト一致しうるため、byte 差分は判定基準にしない。
    expect(savedBytes).not.toBe(original);
    // 通常パスを通った出力が壊れていない（再ロード可能・ページ数維持）ことを確認する。
    const reloaded = await PDFDocument.load(savedBytes, {
      ignoreEncryption: true,
      throwOnInvalidObject: false,
      updateMetadata: false,
    });
    expect(reloaded.getPageCount()).toBe(1);
  });
});
