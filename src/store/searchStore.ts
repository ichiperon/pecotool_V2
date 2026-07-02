import { create } from 'zustand';

interface SearchState {
  searchTerm: string;
  searchHitIndex: number;
  setSearchTerm: (term: string) => void;
  nextSearchHit: (totalHits: number) => void;
  prevSearchHit: (totalHits: number) => void;
  /**
   * SH-7 (#431 / PCT-200): searchHitIndex はページ切替等で totalHits (現在ページの
   * ヒット数) が変化しても自動で追従しない。totalHits を下回るページへ切り替わると
   * 「8/3」のような不正なバッジ表示になる (次の Enter 押下で nextSearchHit/prevSearchHit
   * が呼ばれれば自己回復するが、それまでは不正表示のまま)。
   * 呼び出し側 (OcrEditor) が totalHits 変化を検知して呼び出し、範囲外なら丸める。
   */
  clampSearchHitIndex: (totalHits: number) => void;
}

export const useSearchStore = create<SearchState>((set) => ({
  searchTerm: '',
  searchHitIndex: 0,

  setSearchTerm: (term) => set({ searchTerm: term, searchHitIndex: 0 }),

  nextSearchHit: (totalHits) =>
    set((state) => {
      if (totalHits === 0) return state;
      return { searchHitIndex: (state.searchHitIndex + 1) % totalHits };
    }),

  prevSearchHit: (totalHits) =>
    set((state) => {
      if (totalHits === 0) return state;
      return { searchHitIndex: (state.searchHitIndex - 1 + totalHits) % totalHits };
    }),

  clampSearchHitIndex: (totalHits) =>
    set((state) => {
      if (totalHits === 0) {
        return state.searchHitIndex === 0 ? state : { searchHitIndex: 0 };
      }
      if (state.searchHitIndex >= totalHits) {
        return { searchHitIndex: totalHits - 1 };
      }
      if (state.searchHitIndex < 0) {
        return { searchHitIndex: 0 };
      }
      return state;
    }),
}));

export const selectSearchTerm = (s: SearchState) => s.searchTerm;
export const selectSearchHitIndex = (s: SearchState) => s.searchHitIndex;
