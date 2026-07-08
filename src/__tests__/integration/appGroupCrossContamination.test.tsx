/**
 * R22狩り(交差汚染 HIGH) 再現テスト。
 *
 * 根本原因: OcrEditor の Virtuoso は computeItemKey を持たず index ベースで
 * SortableOcrCard/OcrCard を再利用していた。OcrCard の blockIdRef は
 * フォーカス中でも render のたびに無条件で最新 block.id へ更新される実装のため、
 * リストの並び/構成が変わる (Ctrl+G のグループ化はその典型) と、フォーカス中の
 * カードが別ブロックへ retarget され、以降の blur/unmount コミットが
 * 「編集中だった旧ブロックのテキスト」を「別ブロック」へ書き込んでしまう。
 *
 * 修正:
 *   1. OcrEditor.tsx: Virtuoso に computeItemKey (block.id ベース) を追加し、
 *      コンポーネント同一性を id 固定にして retarget を構造的に防ぐ。
 *   2. App.tsx: handleGroup 冒頭で commitActiveOcrCardEdit() を呼んでから
 *      store を読み直す (旧実装は render 時点の stale な currentPage.textBlocks を
 *      直接使っており、フォーカス中カードの未確定編集がグループ化に反映されなかった)。
 *
 * NOTE (検証範囲について):
 *   本来は実際の App.tsx の handleGroup クロージャをそのまま起動して検証したいが、
 *   本リポジトリの App.tsx は 15 個超のカスタムフックを持つ巨大コンポーネントで、
 *   それら全てをスタブ化して `render(<App />)` する統合テストはこの環境の
 *   vitest(vmThreads プール) 上で CPU 0% のままハングし完走しなかった
 *   (最小の smoke render だけでも再現、本テストのシナリオ固有の問題ではない)。
 *   そのため検証は「実物の OcrEditor / OcrCard / pecoStore / commitActiveOcrCardEdit」
 *   を使い、App.tsx の handleGroup (src/App.tsx:429-461) と同一のアルゴリズム
 *   ("commit → 最新 store 読み直し → マージ → updatePageData") をこのテスト内の
 *   `runHandleGroupLikeAppTsx` として再現して実行する形に切り替えている。
 *   commit の実処理 (flush) と retarget 防止 (computeItemKey) はどちらも本物の
 *   実装を通しているため、根本原因への対処は実物のコードパスで検証できている。
 *   App.tsx 側の diff は commitActiveOcrCardEdit() 呼び出しの追加 + 読み直し先を
 *   getState() に変えただけの小さな並べ替えであり、tsc --noEmit も通過済み。
 */
import { render, fireEvent, cleanup, act } from '@testing-library/react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import type { TextBlock, PageData, PecoDocument } from '../../types'

vi.mock('../../utils/pdfLoader', () => ({
  saveTemporaryPageDataBatch: vi.fn(),
  clearTemporaryChanges: vi.fn(),
  loadPage: vi.fn(),
  destroySharedPdfProxy: vi.fn(),
  getSharedPdfProxy: vi.fn(),
  getCachedPageProxy: vi.fn(),
}))

// OcrEditor.test.tsx と同型の DnD / 仮想化スタブ。computeItemKey を通す点だけ追加。
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: any) => <>{children}</>,
  DragOverlay: ({ children }: any) => <>{children}</>,
  closestCenter: null,
  KeyboardSensor: class {},
  PointerSensor: class {},
  useSensor: vi.fn().mockReturnValue(null),
  useSensors: vi.fn().mockReturnValue([]),
  MeasuringStrategy: { Always: 'always', BeforeDragging: 'before-dragging', WhileDragging: 'while-dragging' },
}))
vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: any) => <>{children}</>,
  sortableKeyboardCoordinates: vi.fn(),
  verticalListSortingStrategy: vi.fn(),
  arrayMove: (arr: any[], from: number, to: number) => {
    const next = arr.slice()
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    return next
  },
  useSortable: vi.fn().mockReturnValue({
    attributes: {}, listeners: {}, setNodeRef: vi.fn(), transform: null, transition: null, isDragging: false,
  }),
}))
vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Transform: { toString: vi.fn().mockReturnValue('') } },
}))
vi.mock('react-virtuoso', async () => {
  const React = await import('react')
  const Virtuoso = React.forwardRef(function Virtuoso(
    { totalCount, itemContent, computeItemKey, className, style }: any,
    ref: any
  ) {
    React.useImperativeHandle(ref, () => ({ scrollIntoView: (args: any) => args?.done?.() }))
    const items = []
    for (let i = 0; i < totalCount; i++) {
      const key = computeItemKey ? computeItemKey(i) : i
      items.push(React.createElement('div', { key, 'data-virtuoso-index': i }, itemContent(i)))
    }
    return React.createElement('div', { className, style }, items)
  })
  return { Virtuoso }
})
vi.mock('lucide-react', () => ({
  GripVertical: () => null,
  Search: () => null,
}))

import { OcrEditor } from '../../components/OcrEditor'
import { usePecoStore } from '../../store/pecoStore'
import { useSearchStore } from '../../store/searchStore'
import { commitActiveOcrCardEdit } from '../../utils/ocrCardCommit'

function makeBlock(id: string, text: string, order: number): TextBlock {
  return {
    id,
    text,
    originalText: text,
    bbox: { x: order * 10, y: 0, width: 100, height: 20 },
    writingMode: 'horizontal',
    order,
    isNew: false,
    isDirty: false,
  }
}

function makeDoc(blocks: TextBlock[]): PecoDocument {
  const page: PageData = {
    pageIndex: 0,
    width: 595,
    height: 842,
    textBlocks: blocks,
    isDirty: false,
    thumbnail: null,
    isTextExtracted: true,
  }
  return {
    filePath: '/test.pdf',
    fileName: 'test.pdf',
    totalPages: 1,
    metadata: {},
    pages: new Map([[0, page]]),
  }
}

/**
 * src/App.tsx:429-461 の handleGroup と同一アルゴリズムをここで再現する。
 * (差異は showToast / perf.mark 呼び出しの省略のみ。commit→読み直し→マージ→
 * updatePageData→setSelectedIds の順序と中身は App.tsx の実装と一致させている)
 */
function runHandleGroupLikeAppTsx(currentPageIndex: number, selectedIds: Set<string>) {
  const currentPage = usePecoStore.getState().document?.pages.get(currentPageIndex)
  if (selectedIds.size < 2 || !currentPage) return

  // fix2: グループ化前に編集中カードの未確定テキストを確定させる。
  commitActiveOcrCardEdit()
  const freshTextBlocks =
    usePecoStore.getState().document?.pages.get(currentPageIndex)?.textBlocks
    ?? currentPage.textBlocks
  const selectedBlocks = freshTextBlocks.filter(b => selectedIds.has(b.id))

  const minX = Math.min(...selectedBlocks.map(b => b.bbox.x))
  const minY = Math.min(...selectedBlocks.map(b => b.bbox.y))
  const maxX = Math.max(...selectedBlocks.map(b => b.bbox.x + b.bbox.width))
  const maxY = Math.max(...selectedBlocks.map(b => b.bbox.y + b.bbox.height))

  const newBlock: TextBlock = {
    id: crypto.randomUUID(),
    text: selectedBlocks.map(b => b.text).join(''),
    originalText: selectedBlocks.map(b => b.originalText).join(''),
    bbox: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    writingMode: selectedBlocks[0].writingMode,
    order: Math.min(...selectedBlocks.map(b => b.order)),
    isNew: true,
    isDirty: true,
  }

  const remainingBlocks = freshTextBlocks.filter(b => !selectedIds.has(b.id))
  const updatedBlocks = [...remainingBlocks, newBlock]
    .sort((a, b) => a.order - b.order)
    .map((b, i) => ({ ...b, order: i }))

  usePecoStore.getState().updatePageData(currentPageIndex, { textBlocks: updatedBlocks, isDirty: true })
  usePecoStore.getState().setSelectedIds([newBlock.id])
}

afterEach(() => cleanup())

beforeEach(() => {
  usePecoStore.setState({
    document: null,
    currentPageIndex: 0,
    selectedIds: new Set<string>(),
    lastSelectedId: null,
    undoStack: [],
    redoStack: [],
    isDirty: false,
    pageOrder: [],
  } as any)
  useSearchStore.setState({ searchTerm: '', searchHitIndex: -1 } as any)
})

describe('R22狩り(交差汚染 HIGH): Ctrl+G グループ化 前後の編集保護', () => {
  it('未確定編集 → handleGroup 相当 → blur で (a) 編集が結合ブロックへ反映され (b) 他ブロックが汚染されない', () => {
    const b1 = makeBlock('b1', 'block one', 0)
    const b2 = makeBlock('b2', 'block two', 1)
    const b3 = makeBlock('b3', 'block three', 2)
    const doc = makeDoc([b1, b2, b3])
    usePecoStore.setState({
      document: doc,
      currentPageIndex: 0,
      selectedIds: new Set(['b1', 'b2']),
      lastSelectedId: 'b2',
    } as any)

    const searchInputRef = { current: null }
    const { container } = render(<OcrEditor width={350} searchInputRef={searchInputRef as any} />)

    // b1 のカードにフォーカスし、blur せずにテキストを変更する (未確定編集)。
    const b1Content = container.querySelector('[data-block-id="b1"].ocr-card-content') as HTMLElement
    expect(b1Content).not.toBeNull()
    act(() => {
      b1Content.focus()
    })
    b1Content.textContent = 'EDITED b1 text'
    fireEvent.input(b1Content)

    // Ctrl+G (= App.tsx の実 handleGroup と同一アルゴリズム) を実行する。
    act(() => {
      runHandleGroupLikeAppTsx(0, new Set(usePecoStore.getState().selectedIds))
    })

    // (a) 結合ブロックに未確定編集が反映されている (fix2: flush してから read)
    let page = usePecoStore.getState().document!.pages.get(0)!
    const merged = page.textBlocks.find(b => b.text.includes('EDITED b1 text'))
    expect(merged).toBeTruthy()
    expect(merged!.text).toBe('EDITED b1 textblock two')
    expect(page.textBlocks).toHaveLength(2) // merged + b3
    expect(page.textBlocks.find(b => b.id === 'b3')!.text).toBe('block three')

    // Ctrl+G 直後、もし computeItemKey が無ければ index 再利用でカードが
    // retarget され、この後の blur が「別ブロック」を上書きしてしまう (交差汚染)。
    // 再レンダー後もまだ同じ DOM ノードにフォーカスが残っている状態で blur する。
    act(() => {
      fireEvent.blur(b1Content)
    })

    // (b) blur 後も結合ブロック・b3 の内容が汚染されていない。
    page = usePecoStore.getState().document!.pages.get(0)!
    expect(page.textBlocks).toHaveLength(2)
    expect(page.textBlocks.find(b => b.id === 'b3')!.text).toBe('block three')
    const mergedAfterBlur = page.textBlocks.find(b => b.text.includes('EDITED b1 text'))
    expect(mergedAfterBlur).toBeTruthy()
    expect(mergedAfterBlur!.text).toBe('EDITED b1 textblock two')
  })
})
