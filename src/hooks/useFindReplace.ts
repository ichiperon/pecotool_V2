/**
 * Find & Replace (issue #93) のロジック層。
 *
 *  - countMatches: 現在の検索条件で何件 / 何ブロック / 何ページ ヒットするかを実行前に算出する
 *  - buildRegexOrError: 検索条件から RegExp を組み立てつつ、正規表現の構文エラーを文字列で返す
 *  - useFindReplace: 上記をまとめて UI から購読しやすい形に。store の replaceText は呼ばない (UI 側で確認を挟むため)。
 *
 *  store.replaceText 側は実行系の責任を持つ。UI ⇄ store の間のプレビュー計算を
 *  ここに切り出して、ReplaceDialog から薄く呼べるようにしている。
 */

import { useCallback, useMemo } from 'react';
import { usePecoStore } from '../store/pecoStore';
import type { PageData } from '../types';

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
 * 与えられた検索 RegExp + scope に対して、現在の document/state からヒット件数を算出する。
 * store からデータを read-only で読み出すので副作用は無い。
 */
export function countMatches(params: {
  re: RegExp;
  scope: ReplaceScope;
  pagesMap: Map<number, PageData> | undefined;
  currentPageIndex: number;
  selectedIds: ReadonlySet<string>;
}): ReplaceCounts {
  const { re, scope, pagesMap, currentPageIndex, selectedIds } = params;
  if (!pagesMap) return { hits: 0, blocks: 0, pages: 0 };

  let pageIndices: number[];
  if (scope === 'selection' || scope === 'current') {
    pageIndices = [currentPageIndex];
  } else {
    pageIndices = Array.from(pagesMap.keys());
  }

  let hits = 0;
  let blocks = 0;
  let pages = 0;

  for (const idx of pageIndices) {
    const page = pagesMap.get(idx);
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
 * UI から使うフック。検索条件とスコープを渡すと、件数 (プレビュー) と
 * regexError の文字列を返す。実行系は store.replaceText を呼び出す。
 */
export function useFindReplace(query: ReplaceQuery, scope: ReplaceScope) {
  const document = usePecoStore(s => s.document);
  const currentPageIndex = usePecoStore(s => s.currentPageIndex);
  const selectedIds = usePecoStore(s => s.selectedIds);

  const regexResult = useMemo(() => buildRegexOrError(query), [query]);

  const counts = useMemo<ReplaceCounts>(() => {
    if ('error' in regexResult) return { hits: 0, blocks: 0, pages: 0 };
    return countMatches({
      re: regexResult.re,
      scope,
      pagesMap: document?.pages,
      currentPageIndex,
      selectedIds,
    });
  }, [regexResult, scope, document?.pages, currentPageIndex, selectedIds]);

  // 構文エラー: 空 pattern の場合は表示しない (error='' で返している)
  const regexError = 'error' in regexResult && regexResult.error ? regexResult.error : null;

  const replaceText = usePecoStore(s => s.replaceText);

  const execute = useCallback(
    (opts?: { skipBlockIds?: ReadonlySet<string> }) => {
      return replaceText({
        scope,
        pattern: query.pattern,
        replacement: '',
        caseSensitive: query.caseSensitive,
        useRegex: query.useRegex,
        skipBlockIds: opts?.skipBlockIds,
      });
    },
    [replaceText, scope, query.pattern, query.caseSensitive, query.useRegex],
  );

  return {
    counts,
    regexError,
    /** dialog 側から実引数で replacement を渡すために返す薄いラッパ */
    runReplace: (replacement: string, opts?: { skipBlockIds?: ReadonlySet<string> }) =>
      replaceText({
        scope,
        pattern: query.pattern,
        replacement,
        caseSensitive: query.caseSensitive,
        useRegex: query.useRegex,
        skipBlockIds: opts?.skipBlockIds,
      }),
    // execute は内部利用 (replacement 空) 用に残しておく
    _executeEmpty: execute,
  };
}
