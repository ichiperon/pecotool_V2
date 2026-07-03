/**
 * ReplaceDialog (issue #93) の UI 振る舞いテスト。
 *
 * - 基本: 入力 + プレビュー + 置換実行ボタン disabled の遷移
 * - スコープ切替で対象集合が変わりプレビューが更新される
 * - 大小区別チェック
 * - 正規表現エラーがインライン表示される
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, fireEvent, screen, cleanup, act, waitFor, within } from '@testing-library/react';

vi.mock('lucide-react', () => ({
  X: () => null,
  Replace: () => null,
  AlertCircle: () => null,
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
  // ルールセットタブは localStorage (pecotool.proofreadingRules) に永続化するため、
  // 前のテストで追加したルールが次のテストの初期表示に残留しないようクリアする。
  localStorage.clear();
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

describe('ReplaceDialog: PCT-187 debounce 窓中の実行ボタン無効化', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('全ページスコープで検索文字列を変更した直後 (debounce 完了前) は置換実行ボタンが disabled のまま', () => {
    const p0 = makePage({ pageIndex: 0, textBlocks: [makeBlock({ text: 'foo' })] });
    const p1 = makePage({ pageIndex: 1, textBlocks: [makeBlock({ text: 'foo foo' })] });
    setupDocument(new Map([[0, p0], [1, p1]]));
    render(<ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={false} />);

    // 全ページスコープへ切り替え、'foo' を検索して debounce (300ms) を完了させる
    fireEvent.click(screen.getByLabelText('全ページ'));
    fireEvent.change(screen.getByLabelText('検索文字列'), { target: { value: 'foo' } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText('3 件 / 2 ブロック / 2 ページ')).toBeTruthy();
    const btn = screen.getByRole('button', { name: '置換実行' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);

    // pattern を書き換えた直後 (debounce 完了前): stale な counts.hits=3 のままだが
    // isSearching=true のため実行ボタンは disabled でなければならない
    fireEvent.change(screen.getByLabelText('検索文字列'), { target: { value: 'f' } });
    expect(screen.getByText('検索中...')).toBeTruthy();
    expect(btn.disabled).toBe(true);

    // debounce 完了後は新しい件数で再度 enable される
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(btn.disabled).toBe(false);
  });

  it('全ページスコープの debounce 窓中に Enter しても onConfirm が呼ばれない (stale hits のすり抜け防止)', () => {
    const p0 = makePage({ pageIndex: 0, textBlocks: [makeBlock({ text: 'foo' })] });
    const p1 = makePage({ pageIndex: 1, textBlocks: [makeBlock({ text: 'foo foo' })] });
    setupDocument(new Map([[0, p0], [1, p1]]));
    const onConfirm = vi.fn();
    render(<ReplaceDialog onClose={() => {}} onConfirm={onConfirm} hasSelection={false} />);

    fireEvent.click(screen.getByLabelText('全ページ'));
    fireEvent.change(screen.getByLabelText('検索文字列'), { target: { value: 'foo' } });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    // debounce 完了前に pattern を変更して即 Enter
    const findInput = screen.getByLabelText('検索文字列');
    fireEvent.change(findInput, { target: { value: 'f' } });
    fireEvent.keyDown(findInput, { key: 'Enter' });

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('現ページ / 選択BB スコープは debounce 0ms のため isSearching が発生せず即時反映される', () => {
    setupDocument(
      new Map([[0, makePage({ textBlocks: [makeBlock({ text: 'foo' })] })]]),
    );
    render(<ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={false} />);

    fireEvent.change(screen.getByLabelText('検索文字列'), { target: { value: 'foo' } });
    // debounce 0ms スコープでは検索中表示は出ない
    expect(screen.queryByText('検索中...')).toBeNull();
    const btn = screen.getByRole('button', { name: '置換実行' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
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

  it('選択BBスコープ表示中に hasSelection が false へ変化すると現ページスコープへフォールバックする', () => {
    const b = makeBlock({ id: 'b1', text: 'foo' });
    setupDocument(new Map([[0, makePage({ textBlocks: [b] })]]), 0, new Set(['b1']));
    const { rerender } = render(
      <ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={true} />,
    );
    expect((screen.getByLabelText('選択BB') as HTMLInputElement).checked).toBe(true);

    // 選択が外れた (例: 他 BB をクリックして選択解除) 想定で hasSelection=false を再レンダリング
    rerender(<ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={false} />);

    expect((screen.getByLabelText('現ページ') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('選択BB') as HTMLInputElement).disabled).toBe(true);
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

/**
 * PCT-187 (#418) 回帰の補完: 既存テストは検索文字列 input の Enter キー経路のみを
 * カバーしていた。置換文字列 input にも同じ onKeyDown ハンドラがあり (未カバー分岐)、
 * stale hits すり抜け防止は両方の input で成立していないと意味がない。
 */
describe('ReplaceDialog: PCT-187 debounce — Enter キー経路 (#418 回帰の補完)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('検索文字列 input で Enter → 有効時 (現ページスコープ・即時) は onConfirm が呼ばれる', () => {
    setupDocument(new Map([[0, makePage({ textBlocks: [makeBlock({ text: 'foo' })] })]]));
    const onConfirm = vi.fn();
    render(<ReplaceDialog onClose={() => {}} onConfirm={onConfirm} hasSelection={false} />);

    const findInput = screen.getByLabelText('検索文字列');
    fireEvent.change(findInput, { target: { value: 'foo' } });
    fireEvent.keyDown(findInput, { key: 'Enter' });

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0].pattern).toBe('foo');
  });

  it('置換文字列 input で Enter → 有効時は onConfirm が呼ばれる (検索文字列と同じ確定経路)', () => {
    setupDocument(new Map([[0, makePage({ textBlocks: [makeBlock({ text: 'foo' })] })]]));
    const onConfirm = vi.fn();
    render(<ReplaceDialog onClose={() => {}} onConfirm={onConfirm} hasSelection={false} />);

    fireEvent.change(screen.getByLabelText('検索文字列'), { target: { value: 'foo' } });
    const replacementInput = screen.getByLabelText('置換文字列');
    fireEvent.change(replacementInput, { target: { value: 'bar' } });
    fireEvent.keyDown(replacementInput, { key: 'Enter' });

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0].replacement).toBe('bar');
  });

  it('全ページスコープの debounce 窓中に置換文字列 input で Enter しても onConfirm が呼ばれない (stale hits すり抜け防止・置換側)', () => {
    const p0 = makePage({ pageIndex: 0, textBlocks: [makeBlock({ text: 'foo' })] });
    const p1 = makePage({ pageIndex: 1, textBlocks: [makeBlock({ text: 'foo foo' })] });
    setupDocument(new Map([[0, p0], [1, p1]]));
    const onConfirm = vi.fn();
    render(<ReplaceDialog onClose={() => {}} onConfirm={onConfirm} hasSelection={false} />);

    fireEvent.click(screen.getByLabelText('全ページ'));
    fireEvent.change(screen.getByLabelText('検索文字列'), { target: { value: 'foo' } });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    // debounce 完了前に pattern を変更 (isSearching=true になる) → 置換文字列側で Enter
    fireEvent.change(screen.getByLabelText('検索文字列'), { target: { value: 'f' } });
    const replacementInput = screen.getByLabelText('置換文字列');
    fireEvent.change(replacementInput, { target: { value: 'bar' } });
    fireEvent.keyDown(replacementInput, { key: 'Enter' });

    expect(onConfirm).not.toHaveBeenCalled();
  });
});

/**
 * 置換実行経路: onConfirm に渡る params の正しさ (スコープ判定・大小区別・正規表現エスケープ・0件ヒット)。
 * 「壊れたら文字が壊れる」観点で、ダイアログが親 (App.tsx→store.replaceText) へ渡す契約面を検証する。
 */
describe('ReplaceDialog: 置換実行 onConfirm パラメータの正しさ', () => {
  it('選択BBスコープ: 選択中ブロックのみが対象になり expectedHits に反映される', () => {
    const selected = makeBlock({ id: 'b1', text: 'foo' });
    const notSelected = makeBlock({ id: 'b2', text: 'foo foo' });
    setupDocument(
      new Map([[0, makePage({ textBlocks: [selected, notSelected] })]]),
      0,
      new Set(['b1']),
    );
    const onConfirm = vi.fn();
    render(<ReplaceDialog onClose={() => {}} onConfirm={onConfirm} hasSelection={true} />);

    fireEvent.change(screen.getByLabelText('検索文字列'), { target: { value: 'foo' } });
    fireEvent.click(screen.getByRole('button', { name: '置換実行' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const call = onConfirm.mock.calls[0][0];
    expect(call.scope).toBe('selection');
    expect(call.expectedHits).toBe(1); // b2 (非選択) は対象外
  });

  it('全ページスコープ: debounce 完了後の正しい expectedHits (2 ページ合算) が渡る', () => {
    vi.useFakeTimers();
    try {
      const p0 = makePage({ pageIndex: 0, textBlocks: [makeBlock({ text: 'foo' })] });
      const p1 = makePage({ pageIndex: 1, textBlocks: [makeBlock({ text: 'foo foo' })] });
      setupDocument(new Map([[0, p0], [1, p1]]));
      const onConfirm = vi.fn();
      render(<ReplaceDialog onClose={() => {}} onConfirm={onConfirm} hasSelection={false} />);

      fireEvent.click(screen.getByLabelText('全ページ'));
      fireEvent.change(screen.getByLabelText('検索文字列'), { target: { value: 'foo' } });
      act(() => {
        vi.advanceTimersByTime(300);
      });

      fireEvent.click(screen.getByRole('button', { name: '置換実行' }));

      expect(onConfirm).toHaveBeenCalledTimes(1);
      const call = onConfirm.mock.calls[0][0];
      expect(call.scope).toBe('all');
      expect(call.expectedHits).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('大小区別 ON が onConfirm.caseSensitive に転送される', () => {
    setupDocument(new Map([[0, makePage({ textBlocks: [makeBlock({ text: 'Foo' })] })]]));
    const onConfirm = vi.fn();
    render(<ReplaceDialog onClose={() => {}} onConfirm={onConfirm} hasSelection={false} />);

    fireEvent.click(screen.getByLabelText('大小区別'));
    fireEvent.change(screen.getByLabelText('検索文字列'), { target: { value: 'Foo' } });
    fireEvent.click(screen.getByRole('button', { name: '置換実行' }));

    expect(onConfirm.mock.calls[0][0].caseSensitive).toBe(true);
  });

  it('正規表現 OFF (リテラル検索) は特殊文字がエスケープされ文字通りにしかマッチしない', () => {
    // 'a.b' をリテラル検索: 'a.b' (ドット文字そのもの) にはヒットし、'axb' (任意の1文字) にはヒットしない
    setupDocument(
      new Map([[0, makePage({ textBlocks: [makeBlock({ text: 'a.b axb' })] })]]),
    );
    const onConfirm = vi.fn();
    render(<ReplaceDialog onClose={() => {}} onConfirm={onConfirm} hasSelection={false} />);

    fireEvent.change(screen.getByLabelText('検索文字列'), { target: { value: 'a.b' } });
    expect(screen.getByText('1 件 / 1 ブロック / 1 ページ')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '置換実行' }));
    expect(onConfirm.mock.calls[0][0].expectedHits).toBe(1);
    expect(onConfirm.mock.calls[0][0].useRegex).toBe(false);
  });

  it('0 件ヒットのときは置換実行ボタンが disabled のままで onConfirm は呼ばれない', () => {
    setupDocument(new Map([[0, makePage({ textBlocks: [makeBlock({ text: 'foo' })] })]]));
    const onConfirm = vi.fn();
    render(<ReplaceDialog onClose={() => {}} onConfirm={onConfirm} hasSelection={false} />);

    fireEvent.change(screen.getByLabelText('検索文字列'), { target: { value: 'zzz' } });
    expect(screen.getByText('0 件 / 0 ブロック / 0 ページ')).toBeTruthy();

    const btn = screen.getByRole('button', { name: '置換実行' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

/**
 * ダイアログ開閉時の state リセット。
 *  - App.tsx は ReplaceDialog を条件付きレンダリングするため、閉じて再度開くと
 *    コンポーネントは再マウントされ、前回の検索文字列が残留しないことを保証する。
 *  - タブ切替 (単発置換 ⇄ ルールセット) でも SingleReplaceTab は都度アンマウント/リマウントされる
 *    (未カバーだった tab onClick 分岐, L85-95 も併せてカバー)。
 */
describe('ReplaceDialog: state 独立性 (再マウント/タブ切替で前回入力が残留しない)', () => {
  it('ダイアログを閉じて (unmount) 再度開く (再mount) と検索文字列はリセットされる', () => {
    setupDocument(new Map([[0, makePage({ textBlocks: [makeBlock({ text: 'foo' })] })]]));
    const { unmount } = render(
      <ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={false} />,
    );
    fireEvent.change(screen.getByLabelText('検索文字列'), { target: { value: 'residual' } });
    expect((screen.getByLabelText('検索文字列') as HTMLInputElement).value).toBe('residual');
    unmount();

    render(<ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={false} />);
    expect((screen.getByLabelText('検索文字列') as HTMLInputElement).value).toBe('');
  });

  it('単発置換→ルールセット→単発置換 とタブ切替すると検索文字列がリセットされる', () => {
    setupDocument(new Map([[0, makePage({ textBlocks: [makeBlock({ text: 'foo' })] })]]));
    render(<ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={false} />);

    fireEvent.change(screen.getByLabelText('検索文字列'), { target: { value: 'residual' } });
    fireEvent.click(screen.getByRole('tab', { name: 'ルールセット' }));
    // 単発置換タブがアンマウントされ、検索文字列 input は存在しない
    expect(screen.queryByLabelText('検索文字列')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: '単発置換' }));
    expect((screen.getByLabelText('検索文字列') as HTMLInputElement).value).toBe('');
  });
});

/**
 * ルールセットタブ (issue #198) のルール管理 UI。従来ノーカバレッジだった領域 (L320-585)。
 */
describe('ReplaceDialog: ルールセットタブ — ルール管理 (issue #198)', () => {
  function openRuleSetTab() {
    setupDocument(new Map([[0, makePage({ textBlocks: [makeBlock({ text: 'foo bar foo' })] })]]));
    render(<ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={false} />);
    fireEvent.click(screen.getByRole('tab', { name: 'ルールセット' }));
  }

  it('初期状態 (ルール無し) はメッセージ表示・一括適用ボタンは disabled', () => {
    openRuleSetTab();
    expect(screen.getByText('ルールがありません。「+ ルール追加」から追加してください。')).toBeTruthy();
    const applyBtn = screen.getByRole('button', { name: /一括適用/ }) as HTMLButtonElement;
    expect(applyBtn.disabled).toBe(true);
  });

  it('「+ ルール追加」でデフォルト値の行が追加される (enabled=true, isRegex/caseSensitive=false)', () => {
    openRuleSetTab();
    fireEvent.click(screen.getByRole('button', { name: '+ ルール追加' }));

    const row = screen.getAllByRole('row')[1]; // [0]はヘッダ行
    const checkboxes = within(row).getAllByRole('checkbox') as HTMLInputElement[];
    // 列順: 有効 / 正規表現 / 大小区別
    expect(checkboxes[0].checked).toBe(true);
    expect(checkboxes[1].checked).toBe(false);
    expect(checkboxes[2].checked).toBe(false);

    // pattern が空のため一括適用の対象件数には含まれない (disabled のまま)
    const applyBtn = screen.getByRole('button', { name: /一括適用/ }) as HTMLButtonElement;
    expect(applyBtn.disabled).toBe(true);
  });

  it('パターン入力後、一括適用が有効化され対象件数が表示される', () => {
    openRuleSetTab();
    fireEvent.click(screen.getByRole('button', { name: '+ ルール追加' }));
    fireEvent.change(screen.getByLabelText('検索パターン'), { target: { value: 'foo' } });

    const applyBtn = screen.getByRole('button', { name: /一括適用/ }) as HTMLButtonElement;
    expect(applyBtn.disabled).toBe(false);
    expect(applyBtn.textContent).toMatch(/1 件/);
  });

  it('enabled チェック OFF のルールは一括適用の対象件数にカウントされない', () => {
    openRuleSetTab();
    fireEvent.click(screen.getByRole('button', { name: '+ ルール追加' }));
    fireEvent.change(screen.getByLabelText('検索パターン'), { target: { value: 'foo' } });

    const row = screen.getAllByRole('row')[1];
    const enabledCheckbox = within(row).getAllByRole('checkbox')[0];
    fireEvent.click(enabledCheckbox); // OFF にする

    const applyBtn = screen.getByRole('button', { name: /一括適用/ }) as HTMLButtonElement;
    expect(applyBtn.disabled).toBe(true);
    expect(applyBtn.textContent).not.toMatch(/件\)/);
  });

  it('ルール行の大小区別チェックとメモ入力が反映される', () => {
    openRuleSetTab();
    fireEvent.click(screen.getByRole('button', { name: '+ ルール追加' }));

    const row = screen.getAllByRole('row')[1];
    const caseSensitiveCheckbox = within(row).getAllByRole('checkbox')[2] as HTMLInputElement;
    expect(caseSensitiveCheckbox.checked).toBe(false);
    fireEvent.click(caseSensitiveCheckbox);
    expect(caseSensitiveCheckbox.checked).toBe(true);

    const noteInput = within(row).getByLabelText('メモ') as HTMLInputElement;
    fireEvent.change(noteInput, { target: { value: 'OCR誤読の補正' } });
    expect(noteInput.value).toBe('OCR誤読の補正');

    // 空文字に戻すと note は undefined 扱いになる (表示上は空のまま)
    fireEvent.change(noteInput, { target: { value: '' } });
    expect(noteInput.value).toBe('');
  });

  it('「JSONインポート」ボタンで隠しファイル input のファイル選択ダイアログが起動する', () => {
    openRuleSetTab();
    const input = screen.getByLabelText('JSONファイルを選択') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click');

    fireEvent.click(screen.getByRole('button', { name: 'JSONインポート' }));

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('ルール削除で行が消え、空状態メッセージに戻る', () => {
    openRuleSetTab();
    fireEvent.click(screen.getByRole('button', { name: '+ ルール追加' }));
    expect(screen.getAllByRole('row').length).toBe(2); // ヘッダ + 1行

    const row = screen.getAllByRole('row')[1];
    fireEvent.click(within(row).getByRole('button')); // 削除ボタン (行内で唯一の button)

    expect(screen.getByText('ルールがありません。「+ ルール追加」から追加してください。')).toBeTruthy();
  });
});

/**
 * ルールセット一括適用 (issue #198/#213)。「壊れたら文字が壊れる」の核心:
 * 一括適用は実ストア (replaceTextBatch, モックなし) を経由して document.pages のテキストを
 * 直接書き換える。ここでの検証は、期待通りの文字列に正しく置換され、undoStack が
 * 1-pass 保証 (issue #213: 全ルールで undoStack エントリ 1 件のみ) を満たすことを確認する。
 */
describe('ReplaceDialog: ルールセット一括適用 — 文字が壊れないことの確認 (issue #198/#213)', () => {
  it('単一ルール: 全ページに正しく反映され、進捗完了表示・undoStack 1件増加', async () => {
    const p0 = makePage({ pageIndex: 0, textBlocks: [makeBlock({ id: 'p0b1', text: 'foo' })] });
    const p1 = makePage({ pageIndex: 1, textBlocks: [makeBlock({ id: 'p1b1', text: 'foo bar foo' })] });
    setupDocument(new Map([[0, p0], [1, p1]]));
    render(<ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={false} />);
    fireEvent.click(screen.getByRole('tab', { name: 'ルールセット' }));

    fireEvent.click(screen.getByRole('button', { name: '+ ルール追加' }));
    fireEvent.change(screen.getByLabelText('検索パターン'), { target: { value: 'foo' } });
    fireEvent.change(screen.getByLabelText('置換文字列'), { target: { value: 'BAZ' } });

    const applyBtn = screen.getByRole('button', { name: /一括適用/ });
    fireEvent.click(applyBtn);

    await waitFor(() => {
      expect(screen.getByText(/完了: 3 件置換 \(1 ルール適用\)/)).toBeTruthy();
    });

    const state = usePecoStore.getState();
    expect(state.document?.pages.get(0)?.textBlocks[0].text).toBe('BAZ');
    expect(state.document?.pages.get(1)?.textBlocks[0].text).toBe('BAZ bar BAZ');
    expect(state.undoStack.length).toBe(1); // 1-pass: undoStack エントリは1件のみ
  });

  it('複数ルール: 前ルールの出力が次ルールの入力になり順次適用される (1-passでundoStack1件)', async () => {
    setupDocument(
      new Map([[0, makePage({ textBlocks: [makeBlock({ id: 'b1', text: 'foo bar foo' })] })]]),
    );
    render(<ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={false} />);
    fireEvent.click(screen.getByRole('tab', { name: 'ルールセット' }));

    // ルール1: foo -> X
    fireEvent.click(screen.getByRole('button', { name: '+ ルール追加' }));
    let row = screen.getAllByRole('row')[1];
    fireEvent.change(within(row).getByLabelText('検索パターン'), { target: { value: 'foo' } });
    fireEvent.change(within(row).getByLabelText('置換文字列'), { target: { value: 'X' } });

    // ルール2: bar -> Y
    fireEvent.click(screen.getByRole('button', { name: '+ ルール追加' }));
    row = screen.getAllByRole('row')[2];
    fireEvent.change(within(row).getByLabelText('検索パターン'), { target: { value: 'bar' } });
    fireEvent.change(within(row).getByLabelText('置換文字列'), { target: { value: 'Y' } });

    const applyBtn = screen.getByRole('button', { name: /一括適用/ });
    expect(applyBtn.textContent).toMatch(/2 件/);
    fireEvent.click(applyBtn);

    await waitFor(() => {
      expect(screen.getByText(/完了: 3 件置換 \(2 ルール適用\)/)).toBeTruthy();
    });

    const state = usePecoStore.getState();
    // 'foo bar foo' -> (foo->X) -> 'X bar X' -> (bar->Y) -> 'X Y X'
    expect(state.document?.pages.get(0)?.textBlocks[0].text).toBe('X Y X');
    expect(state.undoStack.length).toBe(1);
  });
});

/**
 * ルールセット JSON エクスポート/インポート (issue #198)。
 */
describe('ReplaceDialog: ルールセット JSON エクスポート/インポート (issue #198)', () => {
  let originalCreateObjectURL: typeof URL.createObjectURL;
  let originalRevokeObjectURL: typeof URL.revokeObjectURL;

  beforeEach(() => {
    originalCreateObjectURL = URL.createObjectURL;
    originalRevokeObjectURL = URL.revokeObjectURL;
  });
  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  it('JSONエクスポート: Blob URL が生成され、内容が現在のルールセットと一致する', async () => {
    let capturedBlob: Blob | null = null;
    URL.createObjectURL = vi.fn((blob: Blob) => {
      capturedBlob = blob;
      return 'blob:mock-export';
    });
    URL.revokeObjectURL = vi.fn();

    setupDocument(new Map([[0, makePage({ textBlocks: [makeBlock({ text: 'foo' })] })]]));
    render(<ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={false} />);
    fireEvent.click(screen.getByRole('tab', { name: 'ルールセット' }));
    fireEvent.click(screen.getByRole('button', { name: '+ ルール追加' }));
    fireEvent.change(screen.getByLabelText('検索パターン'), { target: { value: 'foo' } });

    fireEvent.click(screen.getByRole('button', { name: 'JSONエクスポート' }));

    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(capturedBlob).not.toBeNull();
    const text = await capturedBlob!.text();
    const parsed = JSON.parse(text);
    expect(parsed.version).toBe(1);
    expect(parsed.rules[0].pattern).toBe('foo');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-export');
  });

  it('JSONインポート: 有効なルールセット JSON を読み込むとルールが反映される', async () => {
    setupDocument(new Map([[0, makePage({ textBlocks: [makeBlock({ text: 'foo' })] })]]));
    render(<ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={false} />);
    fireEvent.click(screen.getByRole('tab', { name: 'ルールセット' }));

    const json = JSON.stringify({
      version: 1,
      rules: [
        { id: 'r1', pattern: 'imported', replacement: 'X', isRegex: false, caseSensitive: false, enabled: true },
      ],
    });
    const file = new File([json], 'ruleset.json', { type: 'application/json' });
    const input = screen.getByLabelText('JSONファイルを選択') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByDisplayValue('imported')).toBeTruthy();
    });
  });

  it('JSONインポート: ファイル選択ダイアログをキャンセルしても (files 未選択) 何も起きない', () => {
    setupDocument(new Map([[0, makePage({ textBlocks: [makeBlock({ text: 'foo' })] })]]));
    render(<ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={false} />);
    fireEvent.click(screen.getByRole('tab', { name: 'ルールセット' }));

    const input = screen.getByLabelText('JSONファイルを選択') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [] } });

    // ルールセットは空のまま・エラーも出ない
    expect(screen.getByText('ルールがありません。「+ ルール追加」から追加してください。')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('JSONインポート: 不正な JSON はエラーメッセージが role="alert" で表示される', async () => {
    setupDocument(new Map([[0, makePage({ textBlocks: [makeBlock({ text: 'foo' })] })]]));
    render(<ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={false} />);
    fireEvent.click(screen.getByRole('tab', { name: 'ルールセット' }));

    const file = new File(['not json{{{'], 'bad.json', { type: 'application/json' });
    const input = screen.getByLabelText('JSONファイルを選択') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/JSON パースエラー/);
    });
  });
});

/**
 * 既知バグ記録 (it.fails・未修正): ルールセットタブは正規表現の構文検証を行わない。
 *
 * 単発置換タブは useFindReplace 経由で regexError を計算し、構文エラー時は
 * 置換実行ボタンを disabled にしてエラーメッセージを表示する (このファイル上部の
 * describe('ReplaceDialog: 正規表現エラー表示') 参照)。
 *
 * 一方ルールセットタブの RuleRow は「正規表現として扱う」チェックのみで、入力された
 * pattern が有効な正規表現かどうかを一切検証しない。無効な正規表現のまま
 * 「一括適用」まで到達すると、store.replaceTextBatch 内の `new RegExp(rule.pattern, flags)`
 * が同期的に throw し、handleBatchApply (ReplaceDialog.tsx) はこれを try/catch していないため
 * Promise が unhandled rejection となる。実際に手元で再現したところ:
 *   - 「一括適用」ボタンは disabled にならない (無効な正規表現でもクリック可能)
 *   - クリック後、進捗表示は "適用中… 0 / 1 ルール" のまま永久に止まる
 *   - ユーザーに見えるエラーメッセージは一切表示されない (成功したのか失敗したのか分からない)
 *   - 該当ルールだけでなく、同一バッチ内の他の (有効な) ルールも一切適用されない
 *     (compiledRules の生成が全ルール分をまとめて行う1回の map() のため)
 *
 * 本テストは「せめて入力時点でエラーが分かるべき」という期待値を検証するが、現状は
 * 検証が一切ないため失敗する。実際に一括適用をクリックして unhandled rejection を
 * 発生させるとテストスイート全体を巻き込む (プロセスレベルの unhandled rejection に
 * より exit code が汚染される) ため、そのクリックは本テストでは行わず、
 * 「バグの根本原因 (入力時未検証)」のみを安全に再現している。
 */
describe('ReplaceDialog: 既知バグ記録 (未修正)', () => {
  it.fails(
    'ルールセットタブは無効な正規表現パターンを入力時に検証しない (単発置換タブとの非対称・未修正)',
    () => {
      setupDocument(new Map([[0, makePage({ textBlocks: [makeBlock({ text: 'abc' })] })]]));
      render(<ReplaceDialog onClose={() => {}} onConfirm={() => {}} hasSelection={false} />);
      fireEvent.click(screen.getByRole('tab', { name: 'ルールセット' }));
      fireEvent.click(screen.getByRole('button', { name: '+ ルール追加' }));

      fireEvent.change(screen.getByLabelText('検索パターン'), { target: { value: '[invalid' } });
      fireEvent.click(screen.getByLabelText('正規表現として扱う'));

      // 期待 (あるべき挙動): 単発置換タブと同様に構文エラーが可視化されるか、
      // 少なくとも一括適用ボタンが disabled になるべき。
      const alert = screen.queryByRole('alert');
      const applyBtn = screen.getByRole('button', { name: /一括適用/ }) as HTMLButtonElement;
      expect(alert !== null || applyBtn.disabled).toBe(true);
    },
  );
});
