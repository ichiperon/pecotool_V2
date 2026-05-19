/**
 * PDF header version helpers shared by the main-thread save path (pdfSaver.ts)
 * and the Web Worker path (pdf.worker.ts).
 *
 * Acrobat 7.0 など古いビューアは PDF 1.6 までしかサポートしないため、
 * @cantoo/pdf-lib が書き換え時に埋め込む `%PDF-1.7` を元 version に戻す必要がある。
 */
import { PDFName } from '@cantoo/pdf-lib';
import type { PDFDocument } from '@cantoo/pdf-lib';

export function extractPdfVersion(bytes: Uint8Array): string | null {
  // #86: BOM (EF BB BF) を許容、PDF 1.7 §7.5.2 で先頭にコメントが許される
  // ため探索範囲を 1024 byte に拡大。
  const skip = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const head = new TextDecoder('latin1').decode(bytes.slice(skip, skip + 1024));
  const m = head.match(/%PDF-(\d+\.\d+)/);
  return m ? m[1] : null;
}

/**
 * 修正 (#30): PDF 1.7 仕様 §7.5.2 によると Acrobat は header の %PDF-x.x と
 * Catalog の /Version の **最大値** を実効バージョンとして採用する。
 * pdf-lib が書き換え時に Catalog へ /Version /1.7 を埋め込むため、header だけ
 * 1.6 に戻しても Catalog 側 1.7 が優先されて Acrobat 7 では「サポートされない
 * バージョン」として開けない。save() 直前に Catalog /Version を削除する。
 */
export function stripCatalogVersion(pdfDoc: PDFDocument, originalVersion?: string | null): void {
  // #85: 原本 Catalog/Version が header より高い場合に削除すると実効バージョン降格
  // でページ内容が壊れる可能性。originalVersion (header) >= Catalog Version の
  // ときだけ削除する (Acrobat 7 互換目的が真に達成される条件)。
  const catalogVersion = pdfDoc.catalog.lookup(PDFName.of('Version'));
  if (!catalogVersion) return;
  if (originalVersion == null) {
    // 元バージョン不明なら触らない (安全側)
    return;
  }
  const catalogVersionStr = catalogVersion.toString().replace(/^\//, '');
  const orig = parseFloat(originalVersion);
  const cat = parseFloat(catalogVersionStr);
  if (Number.isFinite(orig) && Number.isFinite(cat) && orig >= cat) {
    pdfDoc.catalog.delete(PDFName.of('Version'));
  }
  // else: Catalog の方が高い → 削除すると実効バージョン降格、保持
}

export function restorePdfVersion(savedBytes: Uint8Array, version: string): void {
  const target = `%PDF-${version}`;
  const current = new TextDecoder('latin1').decode(savedBytes.slice(0, 16));
  const m = current.match(/%PDF-\d+\.\d+/);
  if (!m || current.startsWith(target)) return;
  const patch = new TextEncoder().encode(target);
  for (let i = 0; i < patch.length && i < m[0].length; i++) {
    savedBytes[m.index! + i] = patch[i];
  }
}
