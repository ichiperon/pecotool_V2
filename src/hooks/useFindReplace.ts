/**
 * Find & Replace (issue #93) のロジック層。
 *
 *  - countMatches: 現在の検索条件で何件 / 何ブロック / 何ページ ヒットするかを実行前に算出する
 *  - buildMatchPreview (issue #98): before/after プレビュー用に、置換前後のテキストと
 *    ハイライト範囲を最大 maxItems ブロック分まで生成する
 *  - buildRegexOrError: 検索条件から RegExp を組み立てつつ、正規表現の構文エラーを文字列で返す
 *  - useFindReplace: 上記をまとめて UI から購読しやすい形に。store の replaceText は呼ばない (UI 側で確認を挟むため)。
 *
 *  store.replaceText 側は実行系の責任を持つ。UI ⇄ store の間のプレビュー計算を
 *  ここに切り出して、ReplaceDialog から薄く呼べるようにしている。
 */

import { useEffect, useMemo, useState } from 'react';
import { usePecoStore } from '../store/pecoStore';
import { getAllTemporaryPageData } from '../utils/pdfLoader';
import { useDebouncedValue } from './useDebouncedValue';
import type { PageData, WritingMode } from '../types';

export type ReplaceScope = 'selection' | 'current' | 'all';

export interface ReplaceQuery {
  pattern: string;
  caseSensitive: boolean;
  useRegex: boolean;
}

export interface ReplaceCounts {
  hits: number;
  blocks: number;
  pages: number;
}

/**
 * issue #98: 1 ブロック分の before/after プレビュー情報。
 *
 *  - before: 置換前のブロックテキスト全体
 *  - after: 置換後のブロックテキスト全体 (replacement を反映)
 *  - beforeRanges: before 文字列中のマッチ位置 [start, end) 配列 (UI 側で <mark> 描画用)
 *  - afterRanges: after 文字列中の置換結果位置 [start, end) 配列 (同上)
 *  - writingMode: 縦書き/横書き判定 (UI 側で writing-mode 切替に使う)
 */
export interface MatchPreviewItem {
  pageIndex: number;
  blockId: string;
  before: string;
  after: string;
  beforeRanges: Array<{ start: number; end: number }>;
  afterRanges: Array<{ start: number; end: number }>;
  writingMode: WritingMode;
}

export interface MatchPreview {
  /** 表示用にスライスされたブロック単位の preview (最大 maxItems 件) */
  items: MatchPreviewItem[];
  /** マッチが存在するブロックの総数 (slice 前) */
  totalBlocks: number;
  /** maxItems で打ち切られたかどうか */
  truncated: boolean;
}

/**
 * 検索文字列を RegExp に変換する。useRegex=false のときは特殊文字を escape する。
 * 構文エラーは Error として返す (try/catch を UI 側で書かなくて済むよう、Result 型風)。
 */
export function buildRegexOrError(query: ReplaceQuery): { re: RegExp } | { error: string } {
  if (query.pattern.length === 0) {
    return { error: '' };
  }
  const flags = `g${query.caseSensitive ? '' : 'i'}`;
  try {
    const re = query.useRegex
      ? new RegExp(query.pattern, flags)
      : new RegExp(query.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    return { re };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * issue #104: scope='all' で IDB 退避ページも走査するため、in-memory pages と IDB の
 * Partial<PageData> をマージして「textBlocks を持つ」見かけ上の Map を作る。
 *  - in-memory に存在するページはそちらを優先 (最新)
 *  - IDB は退避されているページ (textBlocks を持っている entry のみ) を補完
 *  - 戻り値は本物の PageData (in-memory) と、最小限のフィールドを補った PageData の混在
 */
function mergeIdbPages(
  pagesMap: Map<number, PageData> | undefined,
  idbPages: Map<number, Partial<PageData>> | undefined,
): Map<number, PageData> | undefined {
  if (!pagesMap) return pagesMap;
  if (!idbPages || idbPages.size === 0) return pagesMap;
  const merged = new Map(pagesMap);
  for (const [idx, partial] of idbPages.entries()) {
    if (merged.has(idx)) continue;
    if (!partial.textBlocks) continue;
    merged.set(idx, {
      pageIndex: idx,
      width: partial.width ?? 0,
      height: partial.height ?? 0,
      textBlocks: partial.textBlocks,
      isDirty: partial.isDirty ?? false,
      thumbnail: partial.thumbnail ?? null,
      isTextExtracted: partial.isTextExtracted,
      ocrCleared: partial.ocrCleared,
    });
  }
  return merged;
}

/**
 * 与えられた検索 RegExp + scope に対して、現在の document/state からヒット件数を算出する。
 * store からデータを read-only で読み出すので副作用は無い。
 *
 * issue #104: scope='all' のときは LRU 退避ページも対象にするため idbPages を受け取る。
 * 未指定なら in-memory pagesMap のみで集計する (selection/current では IDB 不要)。
 */
export function countMatches(params: {
  re: RegExp;
  scope: ReplaceScope;
  pagesMap: Map<number, PageData> | undefined;
  currentPageIndex: number;
  selectedIds: ReadonlySet<string>;
  idbPages?: Map<number, Partial<PageData>>;
}): ReplaceCounts {
  const { re, scope, pagesMap, currentPageIndex, selectedIds, idbPages } = params;
  if (!pagesMap) return { hits: 0, blocks: 0, pages: 0 };

  const effective = scope === 'all' ? mergeIdbPages(pagesMap, idbPages) : pagesMap;
  if (!effective) return { hits: 0, blocks: 0, pages: 0 };

  let pageIndices: number[];
  if (scope === 'selection' || scope === 'current') {
    pageIndices = [currentPageIndex];
  } else {
    pageIndices = Array.from(effective.keys());
  }

  let hits = 0;
  let blocks = 0;
  let pages = 0;

  for (const idx of pageIndices) {
    const page = effective.get(idx);
    if (!page) continue;
    let pageHasHit = false;
    for (const b of page.textBlocks) {
      if (scope === 'selection' && !selectedIds.has(b.id)) continue;
      // 各ブロックで matchAll を回す前に lastIndex をリセット (グローバル正規表現の罠回避)
      re.lastIndex = 0;
      const m = b.text.match(re);
      if (m && m.length > 0) {
        hits += m.length;
        blocks++;
        pageHasHit = true;
      }
    }
    if (pageHasHit) pages++;
  }

  return { hits, blocks, pages };
}

/**
 * issue #98: before/after プレビュー (最大 maxItems ブロック) を構築する。
 *
 * countMatches と同じ走査ロジックだが、各ブロックで:
 *  - matchAll でマッチ位置を全て収集して beforeRanges を作る
 *  - 同じ RegExp で replace を実行し、replacement 反映後の after 文字列を作る
 *  - after 文字列に対しても、replacement の挿入位置から afterRanges を逆算する
 *
 * パフォーマンス: 全ページスコープで 1000+ ヒットしてもメインスレッドを止めない
 * よう、maxItems に達した時点で walking を打ち切る (truncated=true)。
 * 注意: re は g フラグ前提 (buildRegexOrError で常に g を付けている)。
 */
export function buildMatchPreview(params: {
  re: RegExp;
  replacement: string;
  useRegex: boolean;
  scope: ReplaceScope;
  pagesMap: Map<number, PageData> | undefined;
  currentPageIndex: number;
  selectedIds: ReadonlySet<string>;
  maxItems?: number;
  /** issue #104: scope='all' で IDB 退避ページも走査対象に含める */
  idbPages?: Map<number, Partial<PageData>>;
}): MatchPreview {
  const {
    re,
    replacement,
    useRegex,
    scope,
    pagesMap,
    currentPageIndex,
    selectedIds,
    maxItems = 20,
    idbPages,
  } = params;

  const empty: MatchPreview = { items: [], totalBlocks: 0, truncated: false };
  if (!pagesMap) return empty;

  const effective = scope === 'all' ? mergeIdbPages(pagesMap, idbPages) : pagesMap;
  if (!effective) return empty;

  let pageIndices: number[];
  if (scope === 'selection' || scope === 'current') {
    pageIndices = [currentPageIndex];
  } else {
    pageIndices = Array.from(effective.keys()).sort((a, b) => a - b);
  }

  const items: MatchPreviewItem[] = [];
  let totalBlocks = 0;

  for (const idx of pageIndices) {
    const page = effective.get(idx);
    if (!page) continue;
    for (const b of page.textBlocks) {
      if (scope === 'selection' && !selectedIds.has(b.id)) continue;

      // before のマッチ位置を全列挙
      re.lastIndex = 0;
      const beforeRanges: Array<{ start: number; end: number }> = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(b.text)) !== null) {
        beforeRanges.push({ start: m.index, end: m.index + m[0].length });
        // ゼロ幅マッチ (例: /(?=x)/) で無限ループにならないよう lastIndex を強制的に進める
        if (m[0].length === 0) re.lastIndex++;
      }
      if (beforeRanges.length === 0) continue;

      totalBlocks++;

      if (items.length < maxItems) {
        // after 文字列とハイライト位置を構築
        // useRegex=false の時は $ の特殊扱いを避けるため文字列ベースで結合する
        // (これは buildMatchPreview の元実装どおりで、issue #105 の literal 保証と一致する)
        let after = '';
        const afterRanges: Array<{ start: number; end: number }> = [];
        let cursor = 0;
        for (let i = 0; i < beforeRanges.length; i++) {
          const r = beforeRanges[i];
          after += b.text.slice(cursor, r.start);
          const matched = b.text.slice(r.start, r.end);
          const replaced = useRegex
            ? matched.replace(new RegExp(re.source, re.flags.replace(/g/g, '')), replacement)
            : replacement;
          const insertStart = after.length;
          after += replaced;
          afterRanges.push({ start: insertStart, end: insertStart + replaced.length });
          cursor = r.end;
        }
        after += b.text.slice(cursor);

        items.push({
          pageIndex: idx,
          blockId: b.id,
          before: b.text,
          after,
          beforeRanges,
          afterRanges,
          writingMode: b.writingMode,
        });
      }
    }
  }

  return {
    items,
    totalBlocks,
    truncated: totalBlocks > items.length,
  };
}

/**
 * UI から使うフック。検索条件とスコープを渡すと、件数 (プレビュー) と
 * regexError の文字列を返す。実行系は store.replaceText を呼び出す。
 *
 * issue #104: scope='all' のとき LRU 退避ページ (IDB 退避) も走査対象に含めるため、
 * filePath をキーに getAllTemporaryPageData を非同期で読み込み、結果が来たら counts /
 * preview を再計算する。IDB 読み込み中は in-memory のみで仮表示する (UI の応答性優先)。
 */
export function useFindReplace(
  query: ReplaceQuery,
  scope: ReplaceScope,
  /** issue #98: プレビュー生成用に replacement も受け取る (未指定なら空文字 = 削除) */
  replacement: string = '',
  /** プレビューの上限件数 (default 20) */
  previewMaxItems: number = 20,
) {
  const document = usePecoStore(s => s.document);
  const currentPageIndex = usePecoStore(s => s.currentPageIndex);
  const selectedIds = usePecoStore(s => s.selectedIds);

  // issue #222: scope='all' のとき query 変化に 300ms debounce を入れる。
  // scope='current' / 'selection' は軽量なので 0ms = 即時。
  const debouncedQuery = useDebouncedValue(query, scope === 'all' ? 300 : 0);

  // query と debouncedQuery が一致しない間は走査が未反映 (検索中) とみなす。
  const isSearching = query !== debouncedQuery;

  const regexResult = useMemo(() => buildRegexOrError(debouncedQuery), [debouncedQuery]);

  // issue #104: scope='all' のときだけ IDB 退避ページを取得する。
  // filePath / scope / pages Map 更新で再フェッチして件数を最新化する。
  const filePath = document?.filePath ?? null;
  const pagesMapRef = document?.pages;
  const [idbPages, setIdbPages] = useState<Map<number, Partial<PageData>> | undefined>(undefined);

  useEffect(() => {
    if (scope !== 'all' || !filePath) {
      setIdbPages(undefined);
      return;
    }
    let cancelled = false;
    getAllTemporaryPageData(filePath)
      .then((m) => {
        if (!cancelled) setIdbPages(m);
      })
      .catch(() => {
        if (!cancelled) setIdbPages(undefined);
      });
    return () => {
      cancelled = true;
    };
    // pagesMapRef を deps に入れることで store 側の置換 / undo / redo の後で
    // IDB 側もリフレッシュされる
  }, [scope, filePath, pagesMapRef]);

  const counts = useMemo<ReplaceCounts>(() => {
    if ('error' in regexResult) return { hits: 0, blocks: 0, pages: 0 };
    return countMatches({
      re: regexResult.re,
      scope,
      pagesMap: document?.pages,
      currentPageIndex,
      selectedIds,
      idbPages,
    });
  }, [regexResult, scope, document?.pages, currentPageIndex, selectedIds, idbPages]);

  const preview = useMemo<MatchPreview>(() => {
    if ('error' in regexResult) return { items: [], totalBlocks: 0, truncated: false };
    return buildMatchPreview({
      re: regexResult.re,
      replacement,
      useRegex: debouncedQuery.useRegex,
      scope,
      pagesMap: document?.pages,
      currentPageIndex,
      selectedIds,
      maxItems: previewMaxItems,
      idbPages,
    });
  }, [regexResult, replacement, debouncedQuery.useRegex, scope, document?.pages, currentPageIndex, selectedIds, previewMaxItems, idbPages]);

  // 構文エラー: 空 pattern の場合は表示しない (error='' で返している)
  const regexError = 'error' in regexResult && regexResult.error ? regexResult.error : null;

  const replaceText = usePecoStore(s => s.replaceText);

  return {
    counts,
    /** issue #98: before/after プレビュー (最初の previewMaxItems ブロック) */
    preview,
    regexError,
    /** issue #222: scope='all' でキー入力から 300ms 以内は true (検索中) */
    isSearching,
    /** dialog 側から実引数で replacement を渡すために返す薄いラッパ */
    runReplace: (replacement: string, opts?: { skipBlockIds?: ReadonlySet<string> }) =>
      replaceText({
        scope,
        pattern: debouncedQuery.pattern,
        replacement,
        caseSensitive: debouncedQuery.caseSensitive,
        useRegex: debouncedQuery.useRegex,
        skipBlockIds: opts?.skipBlockIds,
      }),
  };
}
