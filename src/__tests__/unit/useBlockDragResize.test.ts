/**
 * useBlockDragResize: BB ドラッグ移動・リサイズが page.isDirty を立てることを保証する回帰テスト。
 *
 * 背景: 以前は updateDragResize() 内の updatePageData 呼び出しが block.isDirty のみで
 *       page.isDirty を立てていなかった。保存フロー (useFileOperations._executeSave) の
 *       dirtyOnlyPages フィルタは page.isDirty のみを見るため、BB の位置だけ動かした
 *       変更が保存対象から落ちて「保存されない」症状が出ていた。
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBlockDragResize } from '../../hooks/useBlockDragResize';
import type { PageData, TextBlock } from '../../types';

function makeBlock(overrides: Partial<TextBlock> = {}): TextBlock {
  return {
    id: 'b1',
    text: 'text',
    originalText: 'text',
    bbox: { x: 100, y: 100, width: 80, height: 20 },
    writingMode: 'horizontal',
    order: 0,
    isNew: false,
    isDirty: false,
    ...overrides,
  };
}

function makePage(blocks: TextBlock[]): PageData {
  return {
    pageIndex: 0,
    width: 595,
    height: 842,
    textBlocks: blocks,
    isDirty: false,         // ← 初期状態は page.isDirty=false
    thumbnail: null,
  };
}

describe('useBlockDragResize: page.isDirty 伝播', () => {
  it('BB 移動 (updateDragResize move) は page.isDirty:true を明示して updatePageData を呼ぶ', () => {
    const block = makeBlock();
    const pageData = makePage([block]);
    const updatePageData = vi.fn();
    const pushAction = vi.fn();
    const toggleSelection = vi.fn();

    const { result } = renderHook(() =>
      useBlockDragResize({
        pageIndex: 0,
        zoom: 100,
        selectedIds: new Set([block.id]),
        getPageData: () => pageData,
        updatePageData,
        toggleSelection,
        pushAction,
      })
    );

    // ブロック内クリック → move モードに入る
    act(() => {
      result.current.tryStartDragOrResize(
        { x: 110, y: 110 },
        { ctrlKey: false, metaKey: false, shiftKey: false }
      );
    });

    // マウス移動
    act(() => {
      result.current.updateDragResize({ x: 130, y: 120 });
    });

    expect(updatePageData).toHaveBeenCalled();
    const [pageIdx, partial, pushUndo] = updatePageData.mock.calls[0];
    expect(pageIdx).toBe(0);
    // 回帰対象: partial.isDirty が明示的に true でなければならない
    expect(partial.isDirty).toBe(true);
    expect(pushUndo).toBe(false);                       // ドラッグ中は undo を積まない
    expect(Array.isArray(partial.textBlocks)).toBe(true);
    expect(partial.textBlocks[0].isDirty).toBe(true);   // block 側も従来通り立っている
  });

  it('BB リサイズ (updateDragResize resize-se) も page.isDirty:true を明示する', () => {
    const block = makeBlock();
    const pageData = makePage([block]);
    const updatePageData = vi.fn();

    const { result } = renderHook(() =>
      useBlockDragResize({
        pageIndex: 0,
        zoom: 100,
        selectedIds: new Set([block.id]),
        getPageData: () => pageData,
        updatePageData,
        toggleSelection: vi.fn(),
        pushAction: vi.fn(),
      })
    );

    // 右下ハンドル近傍 (x+w=180, y+h=120) をクリックして resize-se に入る
    act(() => {
      result.current.tryStartDragOrResize(
        { x: 180, y: 120 },
        { ctrlKey: false, metaKey: false, shiftKey: false }
      );
    });
    expect(result.current.dragMode).toBe('resize-se');

    // マウス移動でサイズ変更
    act(() => {
      result.current.updateDragResize({ x: 200, y: 140 });
    });

    expect(updatePageData).toHaveBeenCalled();
    const [, partial] = updatePageData.mock.calls[0];
    expect(partial.isDirty).toBe(true);                 // 回帰対象
    expect(partial.textBlocks[0].isDirty).toBe(true);
    expect(partial.textBlocks[0].bbox.width).toBeGreaterThan(block.bbox.width);
  });
});
