import { create } from 'zustand';

interface SearchState {
  searchTerm: string;
  searchHitIndex: number;
  setSearchTerm: (term: string) => void;
  nextSearchHit: (totalHits: number) => void;
  prevSearchHit: (totalHits: number) => void;
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
}));

export const selectSearchTerm = (s: SearchState) => s.searchTerm;
export const selectSearchHitIndex = (s: SearchState) => s.searchHitIndex;
