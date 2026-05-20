/**
 * ReplaceDialog (issue #93) の UI 振る舞いテスト。
 *
 * - 基本: 入力 + プレビュー + 置換実行ボタン disabled の遷移
 * - スコープ切替で対象集合が変わりプレビューが更新される
 * - 大小区別チェック
 * - 正規表現エラーがインライン表示される
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, fireEvent, screen, cleanup } from '@testing-library/react';

vi.mock('lucide-react', () => ({
  X: () => null,
  Replace: () => null,
}));

import { ReplaceDialog } from '../../components/ReplaceDialog';
import { usePecoStore } from '../../store/pecoStore';
import type { PageData, TextBlock } from '../../types';

vi.mock('../../utils/pdfLoader', () => ({
  saveTemporaryPageDataBatch: vi.fn().mockResolvedValue(undefined),
  clearTemporaryChanges: vi.fn().mockResolvedValue(undefined),
  getAllTemporaryPageData: vi.fn().mockResolvedValue(new Map()),
}));

function makeBlock(overrides: Partial<TextBlock> = {}): TextBlock {
  return {
    id: crypto.randomUUID(),
    text: 'test',
    originalText: 'test',
    bbox: { x: 0, y: 0, width: 100, height: 20 },
    writingMode: 'horizontal',
    order: 0,
    isNew: false,
    isDirty: false,
    ...overrides,
  };
}

function makePage(overrides: Partial<PageData> = {}): PageData {
  return {
    pageIndex: 0,
    width: 595,
    height: 842,
    textBlocks: [],
    isDirty: false,
    thumbnail: null,
    ...overrides,
  };
}

function setupDocument(pagesMap: Map<number, PageData>, currentPageIndex = 0, selectedIds = new Set<string>()) {
  usePecoStore.setState({
    document: {
      filePath: 'test.pdf',
      fileName: 'test.pdf',
      totalPages: pagesMap.size,
      metadata: {},
      pages: pagesMap,
    },
    currentPageIndex,
    selectedIds,
    pageAccessOrder: Array.from(pagesMap.keys()),
    undoStack: [],
    redoStack: [],
    isDirty: false,
  });
}

beforeEach(() => {
  // クリーン start: subscribe された箇所が前のテストの document を読まないよう reset
  usePecoStore.setState({
    document: null,
    currentPageIndex: 0,
    selectedIds: new Set(),
    pageAccessOrder: [],
    undoStack: [],
    redoStack: [],
    isDirty: false,
  });
});

afterEach(() => cleanup());

describe('ReplaceDialog (issue #93): 基本動作', () => {
  it('role="dialog" / aria-modal / aria-labelledby が揃う (Modal #40 経由)', () => {
    setupDocument(new Map([[0, makePage({ textBlocks: [makeBlock({ text: 'foo' })] })]]));
    render(
      <ReplaceDialog
        onClose={() => {}}
        onConfirm={() => {}}
        hasSelection={false}
      />
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const titleEl = window.document.getElementById(dialog.getAttribute('aria-labelledby')!);
    expect(titleEl?.textContent).toBe('検索と置換');
  });

  it('検索 input が空のときは置換実行ボタンが disabled', () => {
    setupDocument(new Map([[0, makePage({ textBlocks: [makeBlock({ text: 'foo' })] })]]));
    render(
      <ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={false} />
    );
    const btn = screen.getByRole('button', { name: '置換実行' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('Esc / キャンセル ボタンで onClose が呼ばれる', () => {
    setupDocument(new Map([[0, makePage()]]));
    const onClose = vi.fn();
    render(<ReplaceDialog onClose={onClose} onConfirm={() => {}} hasSelection={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('ReplaceDialog: プレビュー件数', () => {
  it('検索文字列を入れるとプレビュー件数が更新される (現ページスコープ既定)', () => {
    setupDocument(
      new Map([[0, makePage({ textBlocks: [makeBlock({ text: 'あああ' }), makeBlock({ text: 'あい' })] })]]),
    );
    render(<ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={false} />);

    const findInput = screen.getByLabelText('検索文字列');
    fireEvent.change(findInput, { target: { value: 'あ' } });

    // 'あああ'=3hit, 'あい'=1hit → 4 件 / 2 ブロック / 1 ページ
    expect(screen.getByText('4 件 / 2 ブロック / 1 ページ')).toBeTruthy();
    // 置換実行ボタンが enable される
    const btn = screen.getByRole('button', { name: '置換実行' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('全ページスコープに切り替えると他ページも数えられる', () => {
    const p0 = makePage({ pageIndex: 0, textBlocks: [makeBlock({ text: 'foo' })] });
    const p1 = makePage({ pageIndex: 1, textBlocks: [makeBlock({ text: 'foo foo' })] });
    setupDocument(new Map([[0, p0], [1, p1]]));
    render(<ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={false} />);

    fireEvent.change(screen.getByLabelText('検索文字列'), { target: { value: 'foo' } });
    // 現ページ既定では page0 のみ → 1 ヒット
    expect(screen.getByText('1 件 / 1 ブロック / 1 ページ')).toBeTruthy();

    // 全ページ ラジオにスイッチ
    fireEvent.click(screen.getByLabelText('全ページ'));
    // p0=1, p1=2 → 3 件 / 2 ブロック / 2 ページ
    expect(screen.getByText('3 件 / 2 ブロック / 2 ページ')).toBeTruthy();
  });
});

describe('ReplaceDialog: 大小区別', () => {
  it('大小区別 OFF (既定) は Hello/HELLO どちらも 1 件としてカウント', () => {
    setupDocument(
      new Map([[0, makePage({ textBlocks: [makeBlock({ text: 'Hello HELLO hello' })] })]]),
    );
    render(<ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={false} />);

    fireEvent.change(screen.getByLabelText('検索文字列'), { target: { value: 'hello' } });
    expect(screen.getByText('3 件 / 1 ブロック / 1 ページ')).toBeTruthy();
  });

  it('大小区別 ON にすると正確な大小だけがヒットする', () => {
    setupDocument(
      new Map([[0, makePage({ textBlocks: [makeBlock({ text: 'Hello HELLO hello' })] })]]),
    );
    render(<ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={false} />);

    fireEvent.change(screen.getByLabelText('検索文字列'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByLabelText('大小区別'));
    // 'hello' のみマッチ
    expect(screen.getByText('1 件 / 1 ブロック / 1 ページ')).toBeTruthy();
  });
});

describe('ReplaceDialog: 正規表現エラー表示', () => {
  it('正規表現 ON で構文エラーがある pattern を入れるとエラー表示され置換実行も disabled', () => {
    setupDocument(new Map([[0, makePage({ textBlocks: [makeBlock({ text: 'abc' })] })]]));
    render(<ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={false} />);

    fireEvent.click(screen.getByLabelText('正規表現'));
    fireEvent.change(screen.getByLabelText('検索文字列'), { target: { value: '[invalid' } });

    // alert role で error が表示される
    expect(screen.getByRole('alert').textContent).toMatch(/正規表現エラー/);
    // 置換実行は disabled
    const btn = screen.getByRole('button', { name: '置換実行' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('正規表現 ON で valid pattern では件数が更新される', () => {
    setupDocument(
      new Map([[0, makePage({ textBlocks: [makeBlock({ text: 'abc123 def456' })] })]]),
    );
    render(<ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={false} />);

    fireEvent.click(screen.getByLabelText('正規表現'));
    fireEvent.change(screen.getByLabelText('検索文字列'), { target: { value: '\\d+' } });

    // '123' と '456' で 2 ヒット
    expect(screen.getByText('2 件 / 1 ブロック / 1 ページ')).toBeTruthy();
  });
});

describe('ReplaceDialog: selection スコープ無効化', () => {
  it('hasSelection=false のとき selection ラジオは disabled', () => {
    setupDocument(new Map([[0, makePage({ textBlocks: [makeBlock({ text: 'foo' })] })]]));
    render(<ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={false} />);

    const selectionRadio = screen.getByLabelText('選択BB') as HTMLInputElement;
    expect(selectionRadio.disabled).toBe(true);
  });

  it('hasSelection=true のとき selection ラジオが既定で選択される', () => {
    const b = makeBlock({ id: 'b1', text: 'foo' });
    setupDocument(new Map([[0, makePage({ textBlocks: [b] })]]), 0, new Set(['b1']));
    render(<ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={true} />);

    const selectionRadio = screen.getByLabelText('選択BB') as HTMLInputElement;
    expect(selectionRadio.disabled).toBe(false);
    expect(selectionRadio.checked).toBe(true);
  });
});

describe('ReplaceDialog: 置換実行 onConfirm', () => {
  it('置換実行ボタンで onConfirm(params) が呼ばれる', () => {
    setupDocument(
      new Map([[0, makePage({ textBlocks: [makeBlock({ text: 'foo' })] })]]),
    );
    const onConfirm = vi.fn();
    render(<ReplaceDialog onClose={() => {}} onConfirm={onConfirm} hasSelection={false} />);

    fireEvent.change(screen.getByLabelText('検索文字列'), { target: { value: 'foo' } });
    fireEvent.change(screen.getByLabelText('置換文字列'), { target: { value: 'bar' } });

    fireEvent.click(screen.getByRole('button', { name: '置換実行' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const call = onConfirm.mock.calls[0][0];
    expect(call.scope).toBe('current');
    expect(call.pattern).toBe('foo');
    expect(call.replacement).toBe('bar');
    expect(call.caseSensitive).toBe(false);
    expect(call.useRegex).toBe(false);
    expect(call.expectedHits).toBe(1);
  });
});

/**
 * issue #98: before/after プレビュー一覧 UI テスト。
 *  - 検索文字列が空のときはプレビュー非表示
 *  - ヒット時に before/after 行が出る
 *  - <mark> でマッチ箇所がハイライトされる
 *  - 20 件上限が機能して "N 件中" 表記が出る
 *  - 大小区別 / 正規表現でも動く
 *  - 構文エラー時はプレビュー非表示
 */
describe('ReplaceDialog: before/after プレビュー (issue #98)', () => {
  it('検索文字列が空のときはプレビューを表示しない', () => {
    setupDocument(
      new Map([[0, makePage({ textBlocks: [makeBlock({ text: 'foo' })] })]]),
    );
    render(<ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={false} />);
    // before / after ラベルが無いこと
    expect(screen.queryByText('before')).toBeNull();
    expect(screen.queryByText('after')).toBeNull();
  });

  it('ヒットすると before / after 行とハイライトが表示される', () => {
    setupDocument(
      new Map([
        [
          0,
          makePage({
            textBlocks: [makeBlock({ id: 'b3', text: 'こんにちは、あ りがとう' })],
          }),
        ],
      ]),
    );
    render(<ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={false} />);

    fireEvent.change(screen.getByLabelText('検索文字列'), { target: { value: 'あ' } });
    fireEvent.change(screen.getByLabelText('置換文字列'), { target: { value: 'い' } });

    // before / after ラベル
    expect(screen.getByText('before')).toBeTruthy();
    expect(screen.getByText('after')).toBeTruthy();

    // <mark> が 2 個 (before 1 + after 1)
    const marks = window.document.querySelectorAll('mark.replace-preview-mark');
    expect(marks.length).toBe(2);
    expect(marks[0].textContent).toBe('あ');
    expect(marks[1].textContent).toBe('い');
  });

  it('短縮 blockId とページ番号 (p.1 #xxxxxx) が表示される', () => {
    setupDocument(
      new Map([
        [
          0,
          makePage({
            textBlocks: [makeBlock({ id: 'abcdefghijk', text: 'foo' })],
          }),
        ],
      ]),
    );
    render(<ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={false} />);
    fireEvent.change(screen.getByLabelText('検索文字列'), { target: { value: 'foo' } });

    // pageIndex+1 = 1, blockId.slice(0,6)
    expect(screen.getByText('p.1 #abcdef')).toBeTruthy();
  });

  it('20 件上限: 25 ブロック中 20 件表示、"N 件中 20 件表示中" が出る', () => {
    const blocks = [];
    for (let i = 0; i < 25; i++) {
      blocks.push(makeBlock({ id: `b${i}`, text: 'foo' }));
    }
    setupDocument(new Map([[0, makePage({ textBlocks: blocks })]]));
    render(<ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={false} />);

    fireEvent.change(screen.getByLabelText('検索文字列'), { target: { value: 'foo' } });

    // 20 個の before 行
    const beforeLabels = screen.getAllByText('before');
    expect(beforeLabels.length).toBe(20);

    // truncated notation
    expect(screen.getByText(/25 件中 20 件表示中/)).toBeTruthy();
  });

  it('大小区別 ON で hello のみ含むケースを正しくハイライト', () => {
    setupDocument(
      new Map([
        [0, makePage({ textBlocks: [makeBlock({ text: 'Hello HELLO hello' })] })],
      ]),
    );
    render(<ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={false} />);

    fireEvent.change(screen.getByLabelText('検索文字列'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByLabelText('大小区別'));
    fireEvent.change(screen.getByLabelText('置換文字列'), { target: { value: 'hi' } });

    // before に 1 つ、after に 1 つ → 計 2 つ
    const marks = window.document.querySelectorAll('mark.replace-preview-mark');
    expect(marks.length).toBe(2);
    expect(marks[0].textContent).toBe('hello'); // before
    expect(marks[1].textContent).toBe('hi'); // after
  });

  it('正規表現 ON で \\d+ がマッチして数字部分がハイライト', () => {
    setupDocument(
      new Map([
        [0, makePage({ textBlocks: [makeBlock({ text: 'abc123def' })] })],
      ]),
    );
    render(<ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={false} />);

    fireEvent.click(screen.getByLabelText('正規表現'));
    fireEvent.change(screen.getByLabelText('検索文字列'), { target: { value: '\\d+' } });
    fireEvent.change(screen.getByLabelText('置換文字列'), { target: { value: 'N' } });

    const marks = window.document.querySelectorAll('mark.replace-preview-mark');
    expect(marks.length).toBe(2);
    expect(marks[0].textContent).toBe('123'); // before
    expect(marks[1].textContent).toBe('N'); // after
  });

  it('正規表現エラー時はプレビュー非表示', () => {
    setupDocument(
      new Map([[0, makePage({ textBlocks: [makeBlock({ text: 'abc' })] })]]),
    );
    render(<ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={false} />);

    fireEvent.click(screen.getByLabelText('正規表現'));
    fireEvent.change(screen.getByLabelText('検索文字列'), { target: { value: '[invalid' } });

    // エラー表示はある
    expect(screen.getByRole('alert')).toBeTruthy();
    // before / after ラベルは無い
    expect(screen.queryByText('before')).toBeNull();
    expect(screen.queryByText('after')).toBeNull();
  });

  it('XSS: replacement に <script> を入れても escape されてプレーンテキストとして描画', () => {
    setupDocument(
      new Map([[0, makePage({ textBlocks: [makeBlock({ text: 'abc' })] })]]),
    );
    render(<ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={false} />);

    fireEvent.change(screen.getByLabelText('検索文字列'), { target: { value: 'abc' } });
    fireEvent.change(screen.getByLabelText('置換文字列'), {
      target: { value: '<script>x</script>' },
    });

    // dangerouslySetInnerHTML を使っていないので <script> タグは挿入されない
    expect(window.document.querySelectorAll('script').length).toBe(0);
    // テキストとしてプレビューに含まれる (mark の中)
    const afterMark = window.document.querySelectorAll('mark.replace-preview-mark')[1];
    expect(afterMark.textContent).toBe('<script>x</script>');
  });

  it('replacement を変更すると after プレビューが追従する', () => {
    setupDocument(
      new Map([[0, makePage({ textBlocks: [makeBlock({ text: 'foo' })] })]]),
    );
    render(<ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={false} />);

    fireEvent.change(screen.getByLabelText('検索文字列'), { target: { value: 'foo' } });
    fireEvent.change(screen.getByLabelText('置換文字列'), { target: { value: 'BAR' } });
    let marks = window.document.querySelectorAll('mark.replace-preview-mark');
    expect(marks[1].textContent).toBe('BAR');

    fireEvent.change(screen.getByLabelText('置換文字列'), { target: { value: 'XX' } });
    marks = window.document.querySelectorAll('mark.replace-preview-mark');
    expect(marks[1].textContent).toBe('XX');
  });
});
