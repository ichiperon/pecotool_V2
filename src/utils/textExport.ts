import { PecoDocument, PageData } from '../types';

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
