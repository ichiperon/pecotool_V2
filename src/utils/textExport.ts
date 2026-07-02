import { PecoDocument, PageData } from '../types';
import { resolveDisplayIndex } from './pageOrder';

export type TextExportFormat = 'txt' | 'md' | 'csv' | 'json';

/**
 * CSV フィールドを RFC 4180 準拠でクォートする。
 * カンマ / ダブルクォート / 改行 を含む場合はダブルクォートで囲み、
 * フィールド内のダブルクォートは "" にエスケープする。
 */
function csvQuote(value: string): string {
  if (/[,"\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * PecoDocument を指定フォーマットでシリアライズする (pure function)。
 *
 * @param doc エクスポート対象ドキュメント
 * @param format 出力フォーマット ('txt' | 'md' | 'csv' | 'json')
 * @param options
 *   - pageRange: undefined = 全ページ / 'current' = 現在ページのみ /
 *                { start, end } = start..end (inclusive, 0-based)
 *   - currentPageIndex: pageRange='current' 時に使用
 *   - getPageData: LRU 退避ページを IDB から取り戻す callback (省略可)。
 *                  省略時は document.pages に存在するページのみ対象。
 *
 * フォーマット仕様:
 *   - txt: ブロックを order 順で改行区切り、ページ間は "---" 区切り
 *   - md:  ページごとに "## Page N" 見出し、縦書きブロックは "> " 引用
 *   - csv: header = page,order,x,y,width,height,writingMode,text (RFC 4180)
 *   - json: { pages: [{ pageIndex, textBlocks: [...] }] }
 */
export function exportTextFromDocument(
  doc: PecoDocument,
  format: TextExportFormat,
  options?: {
    pageRange?: 'current' | { start: number; end: number };
    currentPageIndex?: number;
    getPageData?: (pageIndex: number) => PageData | undefined;
  },
): string {
  const { pageRange, currentPageIndex = 0, getPageData } = options ?? {};

  // 対象ページインデックスのリストを決定する
  const targetIndices = resolveTargetIndices(doc, pageRange, currentPageIndex);

  // 各ページのデータを取得する (in-memory 優先、なければ getPageData callback)
  const pages: Array<{ pageIndex: number; pageData: PageData }> = [];
  for (const idx of targetIndices) {
    const pageData = doc.pages.get(idx) ?? getPageData?.(idx);
    if (!pageData) continue;
    pages.push({ pageIndex: idx, pageData });
  }

  switch (format) {
    case 'txt':
      return serializeTxt(pages);
    case 'md':
      return serializeMd(pages);
    case 'csv':
      return serializeCsv(pages);
    case 'json':
      return serializeJson(pages);
  }
}

/**
 * #427: 全ページテキストエクスポート時、LRU 退避済み（document.pages から追い出された）
 * ページの内容が無警告で脱落する問題への対処。
 *
 * replaceText 系（#104 対応・pecoStore.ts の scope='all' 実装）と同じ方式で、
 * IDB (temporary_changes ストア) から退避ページの Partial<PageData> を読み出し、
 * displayIndex をキーにした Map を組み立てる。これを `exportTextFromDocument` の
 * `getPageData` コールバックとして渡すことで、in-memory に無いページも
 * エクスポート対象に含められる。
 *
 * @param filePath 対象ファイルパス
 * @param pageOrder 現在の pageOrder（displayIndex -> sourceIndex）
 * @param fetchAllTemporaryPageData getAllTemporaryPageData の DI（テスト容易化のため注入可能にする）
 * @returns
 *   - getPageData: exportTextFromDocument にそのまま渡せるコールバック
 *   - restoredCount: IDB から復元できたページ数
 *   - droppedPageIds: textBlocks が欠落していて復元できなかった pageId（無警告脱落を防ぐため呼び出し元で警告表示に使う）
 */
export async function buildLruAwarePageDataGetter(
  filePath: string,
  pageOrder: number[],
  fetchAllTemporaryPageData: (filePath: string) => Promise<Map<string, Partial<PageData>>>,
): Promise<{
  getPageData: (pageIndex: number) => PageData | undefined;
  restoredCount: number;
  droppedPageIds: string[];
}> {
  const restored = new Map<number, PageData>();
  const droppedPageIds: string[] = [];

  let idbAll: Map<string, Partial<PageData>>;
  try {
    idbAll = await fetchAllTemporaryPageData(filePath);
  } catch {
    // IDB 読み出し失敗時は in-memory のみにフォールバック（エクスポート自体は継続する）
    idbAll = new Map();
  }

  for (const [pageId, partial] of idbAll.entries()) {
    const displayIndex = resolveDisplayIndex(pageOrder, pageId);
    if (displayIndex < 0) continue;
    if (!partial.textBlocks) {
      // textBlocks が無いエントリ（サムネイルのみ等）は復元不可。無警告脱落を防ぐため記録する。
      droppedPageIds.push(pageId);
      continue;
    }
    restored.set(displayIndex, {
      pageIndex: displayIndex,
      width: partial.width ?? 0,
      height: partial.height ?? 0,
      textBlocks: partial.textBlocks,
      isDirty: partial.isDirty ?? false,
      thumbnail: partial.thumbnail ?? null,
      isTextExtracted: partial.isTextExtracted,
    });
  }

  return {
    getPageData: (pageIndex: number) => restored.get(pageIndex),
    restoredCount: restored.size,
    droppedPageIds,
  };
}

// ─── ページインデックス解決 ───────────────────────────────────────────────────

function resolveTargetIndices(
  doc: PecoDocument,
  pageRange: 'current' | { start: number; end: number } | undefined,
  currentPageIndex: number,
): number[] {
  if (pageRange === 'current') {
    return [currentPageIndex];
  }
  if (pageRange && typeof pageRange === 'object') {
    const indices: number[] = [];
    for (let i = pageRange.start; i <= pageRange.end; i++) {
      if (i >= 0 && i < doc.totalPages) {
        indices.push(i);
      }
    }
    return indices;
  }
  // undefined = 全ページ
  const indices: number[] = [];
  for (let i = 0; i < doc.totalPages; i++) {
    indices.push(i);
  }
  return indices;
}

// ─── order 順ソート ──────────────────────────────────────────────────────────

function sortedBlocks(pageData: PageData) {
  return [...pageData.textBlocks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

// ─── TXT シリアライザ ────────────────────────────────────────────────────────

function serializeTxt(pages: Array<{ pageIndex: number; pageData: PageData }>): string {
  const parts: string[] = [];
  for (const { pageData } of pages) {
    const blocks = sortedBlocks(pageData);
    const lines = blocks.map(b => b.text);
    parts.push(lines.join('\n'));
  }
  return parts.join('\n---\n');
}

// ─── Markdown シリアライザ ───────────────────────────────────────────────────

function serializeMd(pages: Array<{ pageIndex: number; pageData: PageData }>): string {
  const sections: string[] = [];
  for (const { pageIndex, pageData } of pages) {
    const lines: string[] = [`## Page ${pageIndex + 1}`];
    const blocks = sortedBlocks(pageData);
    for (const b of blocks) {
      if (b.writingMode === 'vertical') {
        // 縦書きブロックは引用形式で出力
        lines.push(`> ${b.text}`);
      } else {
        lines.push(b.text);
      }
    }
    sections.push(lines.join('\n'));
  }
  return sections.join('\n\n');
}

// ─── CSV シリアライザ (RFC 4180) ─────────────────────────────────────────────

function serializeCsv(pages: Array<{ pageIndex: number; pageData: PageData }>): string {
  const rows: string[] = ['page,order,x,y,width,height,writingMode,text'];
  for (const { pageIndex, pageData } of pages) {
    const blocks = sortedBlocks(pageData);
    for (const b of blocks) {
      const row = [
        String(pageIndex + 1),
        String(b.order),
        String(b.bbox.x),
        String(b.bbox.y),
        String(b.bbox.width),
        String(b.bbox.height),
        b.writingMode,
        csvQuote(b.text),
      ].join(',');
      rows.push(row);
    }
  }
  return rows.join('\r\n');
}

// ─── JSON シリアライザ ───────────────────────────────────────────────────────

function serializeJson(pages: Array<{ pageIndex: number; pageData: PageData }>): string {
  const result = {
    pages: pages.map(({ pageIndex, pageData }) => ({
      pageIndex,
      textBlocks: sortedBlocks(pageData).map(b => ({
        id: b.id,
        order: b.order,
        text: b.text,
        writingMode: b.writingMode,
        bbox: {
          x: b.bbox.x,
          y: b.bbox.y,
          width: b.bbox.width,
          height: b.bbox.height,
        },
      })),
    })),
  };
  return JSON.stringify(result, null, 2);
}
