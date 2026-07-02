/**
 * issue #196: 検索ヒットナビゲーション ロジックのユニットテスト
 *
 * テスト対象:
 *   - searchTerm に対する hit 計算ロジック
 *   - 次/前ナビゲーションの index 計算 (cyclic)
 *   - hit 0 件のケース
 *   - pecoStore.setSearchTerm / nextSearchHit / prevSearchHit
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useSearchStore } from '../../store/searchStore'
import type { TextBlock } from '../../types'

// ── ヘルパー ──────────────────────────────────────────────────

function makeBlock(id: string, text: string): TextBlock {
  return {
    id,
    text,
    originalText: text,
    bbox: { x: 0, y: 0, width: 100, height: 20 },
    writingMode: 'horizontal',
    order: 0,
    isNew: false,
    isDirty: false,
  }
}

/**
 * searchTerm にヒットするブロックを収集する純粋関数 (OcrEditor の useMemo 相当)
 */
function collectHits(blocks: TextBlock[], searchTerm: string): TextBlock[] {
  if (!searchTerm) return []
  const lower = searchTerm.toLowerCase()
  return blocks.filter(b => b.text.toLowerCase().includes(lower))
}

/**
 * 次ヒット index を計算する純粋関数 (store.nextSearchHit 相当)
 */
function nextHitIndex(current: number, totalHits: number): number {
  if (totalHits === 0) return 0
  return (current + 1) % totalHits
}

/**
 * 前ヒット index を計算する純粋関数 (store.prevSearchHit 相当)
 */
function prevHitIndex(current: number, totalHits: number): number {
  if (totalHits === 0) return 0
  return (current - 1 + totalHits) % totalHits
}

// ── hit 計算ロジックのテスト ──────────────────────────────────

describe('searchHitNavigation – hit 計算ロジック', () => {
  const blocks = [
    makeBlock('b0', 'Hello World'),
    makeBlock('b1', 'Goodbye'),
    makeBlock('b2', 'hello again'),
    makeBlock('b3', 'Something else'),
  ]

  it('searchTerm が空文字のとき hits は 0 件', () => {
    const hits = collectHits(blocks, '')
    expect(hits).toHaveLength(0)
  })

  it('マッチするブロックが正しく抽出される', () => {
    const hits = collectHits(blocks, 'hello')
    expect(hits).toHaveLength(2)
    expect(hits[0].id).toBe('b0')
    expect(hits[1].id).toBe('b2')
  })

  it('大文字小文字を区別せずにマッチする (case insensitive)', () => {
    const hits = collectHits(blocks, 'HELLO')
    expect(hits).toHaveLength(2)
  })

  it('どのブロックにもヒットしないとき hits は 0 件', () => {
    const hits = collectHits(blocks, 'xyz_not_found')
    expect(hits).toHaveLength(0)
  })

  it('全ブロックにヒットするとき全件返す', () => {
    // 全テキストに共通する文字で検索
    const allBlocks = [
      makeBlock('a0', 'あ'),
      makeBlock('a1', 'あい'),
      makeBlock('a2', 'あいう'),
    ]
    const hits = collectHits(allBlocks, 'あ')
    expect(hits).toHaveLength(3)
  })

  it('部分一致でヒットする', () => {
    const hits = collectHits(blocks, 'ell')
    // 'Hello World' (ell) + 'hello again' (ell) → 2件
    expect(hits).toHaveLength(2)
  })

  it('特殊文字を含む searchTerm でも正常動作する (includes による検索)', () => {
    const specialBlocks = [
      makeBlock('s0', 'price: $100'),
      makeBlock('s1', 'discount: (10%)'),
      makeBlock('s2', 'normal text'),
    ]
    const hits = collectHits(specialBlocks, '$100')
    expect(hits).toHaveLength(1)
    expect(hits[0].id).toBe('s0')
  })
})

// ── 前/次ナビゲーション index 計算のテスト ──────────────────

describe('searchHitNavigation – 次/前ナビゲーション index 計算', () => {
  it('次ナビ: 0 → 1 → 2 と進む', () => {
    expect(nextHitIndex(0, 3)).toBe(1)
    expect(nextHitIndex(1, 3)).toBe(2)
  })

  it('次ナビ: 末尾から先頭に循環する', () => {
    expect(nextHitIndex(2, 3)).toBe(0)
  })

  it('前ナビ: 2 → 1 → 0 と戻る', () => {
    expect(prevHitIndex(2, 3)).toBe(1)
    expect(prevHitIndex(1, 3)).toBe(0)
  })

  it('前ナビ: 先頭から末尾に循環する', () => {
    expect(prevHitIndex(0, 3)).toBe(2)
  })

  it('hit 0 件のとき次ナビは 0 を返す', () => {
    expect(nextHitIndex(0, 0)).toBe(0)
  })

  it('hit 0 件のとき前ナビは 0 を返す', () => {
    expect(prevHitIndex(0, 0)).toBe(0)
  })

  it('hit 1 件のとき次ナビは常に 0 に留まる', () => {
    expect(nextHitIndex(0, 1)).toBe(0)
  })

  it('hit 1 件のとき前ナビは常に 0 に留まる', () => {
    expect(prevHitIndex(0, 1)).toBe(0)
  })
})

// ── searchStore の searchTerm / nextSearchHit / prevSearchHit のテスト ──

describe('searchHitNavigation – searchStore actions', () => {
  beforeEach(() => {
    useSearchStore.setState({ searchTerm: '', searchHitIndex: 0 })
  })

  it('setSearchTerm で searchTerm が更新される', () => {
    useSearchStore.getState().setSearchTerm('hello')
    expect(useSearchStore.getState().searchTerm).toBe('hello')
  })

  it('setSearchTerm で searchHitIndex が 0 にリセットされる', () => {
    useSearchStore.setState({ searchHitIndex: 5 })
    useSearchStore.getState().setSearchTerm('new term')
    expect(useSearchStore.getState().searchHitIndex).toBe(0)
  })

  it('setSearchTerm で空文字を設定すると searchTerm が空になる', () => {
    useSearchStore.getState().setSearchTerm('hello')
    useSearchStore.getState().setSearchTerm('')
    expect(useSearchStore.getState().searchTerm).toBe('')
    expect(useSearchStore.getState().searchHitIndex).toBe(0)
  })

  it('nextSearchHit で searchHitIndex が次に進む', () => {
    useSearchStore.setState({ searchHitIndex: 0 })
    useSearchStore.getState().nextSearchHit(3)
    expect(useSearchStore.getState().searchHitIndex).toBe(1)
  })

  it('nextSearchHit: 末尾から先頭に循環する', () => {
    useSearchStore.setState({ searchHitIndex: 2 })
    useSearchStore.getState().nextSearchHit(3)
    expect(useSearchStore.getState().searchHitIndex).toBe(0)
  })

  it('prevSearchHit で searchHitIndex が前に戻る', () => {
    useSearchStore.setState({ searchHitIndex: 2 })
    useSearchStore.getState().prevSearchHit(3)
    expect(useSearchStore.getState().searchHitIndex).toBe(1)
  })

  it('prevSearchHit: 先頭から末尾に循環する', () => {
    useSearchStore.setState({ searchHitIndex: 0 })
    useSearchStore.getState().prevSearchHit(3)
    expect(useSearchStore.getState().searchHitIndex).toBe(2)
  })

  it('nextSearchHit: totalHits=0 のとき state を変更しない', () => {
    useSearchStore.setState({ searchHitIndex: 0 })
    useSearchStore.getState().nextSearchHit(0)
    expect(useSearchStore.getState().searchHitIndex).toBe(0)
  })

  it('prevSearchHit: totalHits=0 のとき state を変更しない', () => {
    useSearchStore.setState({ searchHitIndex: 0 })
    useSearchStore.getState().prevSearchHit(0)
    expect(useSearchStore.getState().searchHitIndex).toBe(0)
  })
})

// ── SH-7 (#431 / PCT-200): clampSearchHitIndex ──────────────────────

describe('searchHitNavigation – SH-7: clampSearchHitIndex', () => {
  beforeEach(() => {
    useSearchStore.setState({ searchTerm: 'x', searchHitIndex: 0 })
  })

  it('searchHitIndex が totalHits 未満なら変更しない', () => {
    useSearchStore.setState({ searchHitIndex: 1 })
    useSearchStore.getState().clampSearchHitIndex(3)
    expect(useSearchStore.getState().searchHitIndex).toBe(1)
  })

  it('ページ切替でヒット数が減ると searchHitIndex を範囲内 (totalHits-1) に丸める（「8/3」バグの再現条件）', () => {
    // 旧ページで 8 件目 (index=7) を見ていた状態を再現
    useSearchStore.setState({ searchHitIndex: 7 })
    // 新ページのヒット数は 3 件のみ
    useSearchStore.getState().clampSearchHitIndex(3)
    expect(useSearchStore.getState().searchHitIndex).toBe(2) // 0-based: 3件中最後は index=2
  })

  it('totalHits=0 になったら searchHitIndex を 0 に戻す', () => {
    useSearchStore.setState({ searchHitIndex: 5 })
    useSearchStore.getState().clampSearchHitIndex(0)
    expect(useSearchStore.getState().searchHitIndex).toBe(0)
  })

  it('searchHitIndex が既に 0 で totalHits=0 のときは無駄な set をしない (同一 state 参照)', () => {
    useSearchStore.setState({ searchHitIndex: 0 })
    const before = useSearchStore.getState()
    useSearchStore.getState().clampSearchHitIndex(0)
    const after = useSearchStore.getState()
    expect(after).toBe(before) // set() が state を差し替えていないことを参照同一性で確認
  })

  it('searchHitIndex が負値のときは 0 に補正する (防御的)', () => {
    useSearchStore.setState({ searchHitIndex: -1 })
    useSearchStore.getState().clampSearchHitIndex(3)
    expect(useSearchStore.getState().searchHitIndex).toBe(0)
  })
})
