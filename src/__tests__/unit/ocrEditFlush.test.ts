/**
 * Phase 5 Wave 2: ocrEditFlush テスト
 * Case: U-OE-05 — flush 中のドキュメント切替で結果が破棄される（race）
 *
 * flushActiveOcrCardText は DOM の activeElement を見て、
 * .ocr-card-content[data-page-index][data-block-id] に一致する場合のみ
 * updatePageData を呼ぶ純粋関数。
 *
 * テスト戦略:
 * - DOM を jsdom で操作して activeElement をセットアップ
 * - updatePageData のモック関数で呼び出しを検証
 * - ドキュメント切替後は document が null になるため no-op
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { flushActiveOcrCardText } from '../../utils/ocrEditFlush';
import type { PecoDocument, PageData, TextBlock } from '../../types';

// ── ヘルパー ───────────────────────────────────────────────────

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
  };
}

function makePage(pageIndex: number, blocks: TextBlock[]): PageData {
  return {
    pageIndex,
    width: 595,
    height: 842,
    textBlocks: blocks,
    isDirty: false,
    thumbnail: null,
  };
}

function makeDoc(pages: Map<number, PageData>): PecoDocument {
  return {
    filePath: 'test.pdf',
    fileName: 'test.pdf',
    totalPages: pages.size,
    metadata: {},
    pages,
  };
}

/**
 * jsdom に .ocr-card-content 要素を生成して focus する。
 * 返り値はクリーンアップ関数。
 */
function setupActiveOcrCard(pageIndex: number, blockId: string, text: string): () => void {
  const div = document.createElement('div');
  div.className = 'ocr-card-content';
  div.dataset.pageIndex = String(pageIndex);
  div.dataset.blockId = blockId;
  div.textContent = text;
  div.setAttribute('tabindex', '0');
  document.body.appendChild(div);
  div.focus();

  return () => {
    document.body.removeChild(div);
  };
}

afterEach(() => {
  // 残留 DOM をクリーンアップ
  document.body.innerHTML = '';
});

// ── 正常系テスト ─────────────────────────────────────────────

describe('flushActiveOcrCardText — 正常系', () => {
  it('activeElement が .ocr-card-content で text が変化している場合 updatePageData が呼ばれる', () => {
    const blockId = 'block-001';
    const originalText = '元テキスト';
    const newText = '変更後テキスト';

    const block = makeBlock(blockId, originalText);
    const page = makePage(0, [block]);
    const doc = makeDoc(new Map([[0, page]]));

    const cleanup = setupActiveOcrCard(0, blockId, newText);
    try {
      const updatePageData = vi.fn();
      const result = flushActiveOcrCardText(updatePageData, doc);

      expect(result).toBe(true);
      expect(updatePageData).toHaveBeenCalledOnce();
      const [calledPageIndex, calledData] = updatePageData.mock.calls[0];
      expect(calledPageIndex).toBe(0);
      expect(calledData.isDirty).toBe(true);
      // textBlocks 内の対象ブロックが更新されている
      const updatedBlock = (calledData.textBlocks as TextBlock[]).find((b) => b.id === blockId);
      expect(updatedBlock?.text).toBe(newText);
      expect(updatedBlock?.isDirty).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('text が変化していない場合 updatePageData は呼ばれない', () => {
    const blockId = 'block-002';
    const sameText = '変化なし';

    const block = makeBlock(blockId, sameText);
    const page = makePage(0, [block]);
    const doc = makeDoc(new Map([[0, page]]));

    const cleanup = setupActiveOcrCard(0, blockId, sameText);
    try {
      const updatePageData = vi.fn();
      const result = flushActiveOcrCardText(updatePageData, doc);

      expect(result).toBe(false);
      expect(updatePageData).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('空文字列への変更も検出できる', () => {
    const blockId = 'block-003';
    const originalText = '消えるテキスト';
    const newText = '';

    const block = makeBlock(blockId, originalText);
    const page = makePage(0, [block]);
    const doc = makeDoc(new Map([[0, page]]));

    const cleanup = setupActiveOcrCard(0, blockId, newText);
    try {
      const updatePageData = vi.fn();
      const result = flushActiveOcrCardText(updatePageData, doc);

      expect(result).toBe(true);
      expect(updatePageData).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});

// ── U-OE-05: ドキュメント切替時の race 防止 ──────────────────────

describe('U-OE-05: flushActiveOcrCardText — ドキュメント切替 race 防止', () => {
  it('document=null のとき flush 結果が破棄される (false を返す)', () => {
    const cleanup = setupActiveOcrCard(0, 'block-x', '変更あり');
    try {
      const updatePageData = vi.fn();
      const result = flushActiveOcrCardText(updatePageData, null);

      // document が null なら page.textBlocks にアクセスできないため no-op
      expect(result).toBe(false);
      expect(updatePageData).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('document に対象 pageIndex のページが存在しない場合も no-op', () => {
    // pageIndex=99 のページは doc に存在しない
    const doc = makeDoc(new Map([[0, makePage(0, [makeBlock('b1', 'text')])]]));

    const cleanup = setupActiveOcrCard(99, 'b1', '変更後');
    try {
      const updatePageData = vi.fn();
      const result = flushActiveOcrCardText(updatePageData, doc);

      expect(result).toBe(false);
      expect(updatePageData).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('pageIndex が一致するが blockId が存在しない場合も no-op', () => {
    const doc = makeDoc(new Map([[0, makePage(0, [makeBlock('exists', 'text')])]]));

    // 存在しない blockId を持つ要素を focus
    const cleanup = setupActiveOcrCard(0, 'does-not-exist', '変更後');
    try {
      const updatePageData = vi.fn();
      const result = flushActiveOcrCardText(updatePageData, doc);

      expect(result).toBe(false);
      expect(updatePageData).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('OCR 中にドキュメントが差し替えられた後 flush しても新 document に書き込まれない', () => {
    // シナリオ: OCR が走っていた旧 document の blockId が
    // 新 document (別ファイル) には存在しないケース
    const oldBlockId = 'ocr-block-old';
    const newDoc = makeDoc(new Map([[0, makePage(0, [makeBlock('new-block', 'new text')])]]));

    // 旧 document のブロックに対応する DOM をフォーカスしたまま、
    // document が新しいものに差し替えられた状況をシミュレート
    const cleanup = setupActiveOcrCard(0, oldBlockId, 'OCR結果');
    try {
      const updatePageData = vi.fn();
      // 新 doc には oldBlockId が存在しない → no-op
      const result = flushActiveOcrCardText(updatePageData, newDoc);

      expect(result).toBe(false);
      expect(updatePageData).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});

// ── 異常系: DOM 構造の不正 ────────────────────────────────────

describe('flushActiveOcrCardText — DOM 異常系', () => {
  it('activeElement が HTMLElement でない場合は false を返す', () => {
    // SVGElement は HTMLElement ではない
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    document.body.appendChild(svg);
    svg.setAttribute('tabindex', '0');
    svg.focus();

    try {
      const updatePageData = vi.fn();
      const result = flushActiveOcrCardText(updatePageData, null);
      expect(result).toBe(false);
      expect(updatePageData).not.toHaveBeenCalled();
    } finally {
      document.body.removeChild(svg);
    }
  });

  it('activeElement が .ocr-card-content クラスを持たない場合は false を返す', () => {
    const div = document.createElement('div');
    div.className = 'other-class';
    div.dataset.pageIndex = '0';
    div.dataset.blockId = 'b1';
    div.textContent = 'text';
    div.setAttribute('tabindex', '0');
    document.body.appendChild(div);
    div.focus();

    try {
      const updatePageData = vi.fn();
      const result = flushActiveOcrCardText(updatePageData, null);
      expect(result).toBe(false);
    } finally {
      document.body.removeChild(div);
    }
  });

  it('data-page-index が整数でない場合は false を返す', () => {
    const div = document.createElement('div');
    div.className = 'ocr-card-content';
    div.dataset.pageIndex = 'not-a-number';
    div.dataset.blockId = 'b1';
    div.textContent = 'text';
    div.setAttribute('tabindex', '0');
    document.body.appendChild(div);
    div.focus();

    try {
      const updatePageData = vi.fn();
      const doc = makeDoc(new Map([[0, makePage(0, [makeBlock('b1', 'old')])]]));
      const result = flushActiveOcrCardText(updatePageData, doc);
      expect(result).toBe(false);
      expect(updatePageData).not.toHaveBeenCalled();
    } finally {
      document.body.removeChild(div);
    }
  });

  it('data-block-id が存在しない場合は false を返す', () => {
    const div = document.createElement('div');
    div.className = 'ocr-card-content';
    div.dataset.pageIndex = '0';
    // blockId を設定しない
    div.textContent = 'text';
    div.setAttribute('tabindex', '0');
    document.body.appendChild(div);
    div.focus();

    try {
      const updatePageData = vi.fn();
      const doc = makeDoc(new Map([[0, makePage(0, [makeBlock('b1', 'old')])]]));
      const result = flushActiveOcrCardText(updatePageData, doc);
      expect(result).toBe(false);
    } finally {
      document.body.removeChild(div);
    }
  });
});

// ── PCT-051: IME 変換中の flush スキップ ────────────────────────

describe('PCT-051: flushActiveOcrCardText — IME 変換中は flush しない', () => {
  /**
   * data-composing="true" が設定された要素でフォーカスされている場合、
   * flush をスキップして false を返す（未確定文字列を store に commit しない）。
   */
  it('data-composing="true" の場合 updatePageData は呼ばれない', () => {
    const blockId = 'block-ime-01';
    const originalText = '確定済みテキスト';
    // DOM の textContent には未確定候補文字が混入している想定
    const textWithComposing = '確定済みテキストあ';

    const block = makeBlock(blockId, originalText);
    const page = makePage(0, [block]);
    const doc = makeDoc(new Map([[0, page]]));

    const div = document.createElement('div');
    div.className = 'ocr-card-content';
    div.dataset.pageIndex = '0';
    div.dataset.blockId = blockId;
    div.dataset.composing = 'true'; // compositionstart で設定されるフラグ
    div.textContent = textWithComposing;
    div.setAttribute('tabindex', '0');
    document.body.appendChild(div);
    div.focus();

    try {
      const updatePageData = vi.fn();
      const result = flushActiveOcrCardText(updatePageData, doc);

      // composing 中は flush をスキップ
      expect(result).toBe(false);
      expect(updatePageData).not.toHaveBeenCalled();
    } finally {
      document.body.removeChild(div);
    }
  });

  it('data-composing 属性がない場合は通常通り flush する', () => {
    const blockId = 'block-ime-02';
    const originalText = '元のテキスト';
    const newText = '確定後テキスト';

    const block = makeBlock(blockId, originalText);
    const page = makePage(0, [block]);
    const doc = makeDoc(new Map([[0, page]]));

    const div = document.createElement('div');
    div.className = 'ocr-card-content';
    div.dataset.pageIndex = '0';
    div.dataset.blockId = blockId;
    // data-composing は設定しない (compositionend で削除済みの状態)
    div.textContent = newText;
    div.setAttribute('tabindex', '0');
    document.body.appendChild(div);
    div.focus();

    try {
      const updatePageData = vi.fn();
      const result = flushActiveOcrCardText(updatePageData, doc);

      // composing 中でなければ通常通り flush される
      expect(result).toBe(true);
      expect(updatePageData).toHaveBeenCalledOnce();
      const [, calledData] = updatePageData.mock.calls[0];
      const updatedBlock = (calledData.textBlocks as ReturnType<typeof makeBlock>[]).find(
        (b) => b.id === blockId
      );
      expect(updatedBlock?.text).toBe(newText);
    } finally {
      document.body.removeChild(div);
    }
  });

  it('data-composing="false" (非 "true") の場合は通常通り flush する', () => {
    const blockId = 'block-ime-03';
    const originalText = '旧テキスト';
    const newText = '新テキスト';

    const block = makeBlock(blockId, originalText);
    const page = makePage(0, [block]);
    const doc = makeDoc(new Map([[0, page]]));

    const div = document.createElement('div');
    div.className = 'ocr-card-content';
    div.dataset.pageIndex = '0';
    div.dataset.blockId = blockId;
    div.dataset.composing = 'false'; // "true" でなければスキップしない
    div.textContent = newText;
    div.setAttribute('tabindex', '0');
    document.body.appendChild(div);
    div.focus();

    try {
      const updatePageData = vi.fn();
      const result = flushActiveOcrCardText(updatePageData, doc);

      expect(result).toBe(true);
      expect(updatePageData).toHaveBeenCalledOnce();
    } finally {
      document.body.removeChild(div);
    }
  });
});
