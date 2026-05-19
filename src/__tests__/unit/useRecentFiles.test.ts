/**
 * useRecentFiles の sessionStorage→localStorage 移行ロジックの回帰テスト。
 *
 * #81: メイン Window と Preview Window (#preview) は同じバンドルを共有するため、
 *      無条件で `sessionStorage.removeItem('peco-recent-files')` を実行すると
 *      先勝ちで session 側を消した Window 以外は移行前データへアクセス不可になる。
 *      - #preview / #thumbnails では useRecentFiles は no-op (early return)
 *      - localStorage 書き込みに失敗した場合は sessionStorage を消さない
 * #37: localStorage 保存 → アプリ再起動相当でも履歴が残る (移行成功パスの維持)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRecentFiles } from '../../hooks/useRecentFiles';

function setHash(hash: string) {
  // vmThreads pool では location が完全 readonly になる場合があるので、
  // useTauriCloseGuard.test.ts と同じ二段構えで設定する。
  try {
    window.location.hash = hash;
  } catch {
    Object.defineProperty(window, 'location', {
      value: { hash },
      writable: true,
      configurable: true,
    });
  }
}

describe('useRecentFiles', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    setHash('');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setHash('');
  });

  describe('#81: Preview/Thumbnails Window では no-op', () => {
    it('#preview hash の場合、sessionStorage を一切触らない (early return)', () => {
      // session 側に旧データを残した状態で Preview Window 相当でマウントする
      sessionStorage.setItem('peco-recent-files', JSON.stringify(['/old/session.pdf']));
      setHash('#preview');

      const { result } = renderHook(() => useRecentFiles());

      // session も local も触られていない (sessionStorage は維持される)
      expect(sessionStorage.getItem('peco-recent-files')).toBe(
        JSON.stringify(['/old/session.pdf']),
      );
      expect(localStorage.getItem('peco-recent-files')).toBeNull();
      // recentFiles 状態は空 (load 自体が走っていない)
      expect(result.current.recentFiles).toEqual([]);
    });

    it('#thumbnails hash の場合も no-op', () => {
      sessionStorage.setItem('peco-recent-files', JSON.stringify(['/thumb.pdf']));
      setHash('#thumbnails');

      renderHook(() => useRecentFiles());

      expect(sessionStorage.getItem('peco-recent-files')).toBe(
        JSON.stringify(['/thumb.pdf']),
      );
      expect(localStorage.getItem('peco-recent-files')).toBeNull();
    });

    it('Preview で no-op だった場合、後続でメイン Window が同じ session を移行できる', () => {
      // #81 が再現していた条件: Preview が先勝ちで session を消してしまうと
      // メイン Window 側で session→local の移行ができなくなっていた。
      sessionStorage.setItem('peco-recent-files', JSON.stringify(['/shared.pdf']));

      // Step 1: Preview Window 相当でマウント (no-op)
      setHash('#preview');
      renderHook(() => useRecentFiles());
      expect(sessionStorage.getItem('peco-recent-files')).not.toBeNull();

      // Step 2: メイン Window 相当でマウント (移行が走る)
      setHash('');
      const { result } = renderHook(() => useRecentFiles());

      // 旧 session データが local 側に移行され、UI 状態にも反映されている
      expect(localStorage.getItem('peco-recent-files')).toBe(
        JSON.stringify(['/shared.pdf']),
      );
      expect(sessionStorage.getItem('peco-recent-files')).toBeNull();
      expect(result.current.recentFiles).toEqual(['/shared.pdf']);
    });
  });

  describe('#81: localStorage 書き込み失敗時 sessionStorage を保持', () => {
    it('localStorage.setItem が QuotaExceeded で失敗した場合、sessionStorage を消さない', () => {
      sessionStorage.setItem('peco-recent-files', JSON.stringify(['/quota.pdf']));
      // local 側は空 → 通常なら session から移行されるパスに入る
      expect(localStorage.getItem('peco-recent-files')).toBeNull();

      // localStorage.setItem だけ QuotaExceededError で reject させる。
      // sessionStorage.setItem は beforeEach で既に呼ばれており、本テスト中は
      // 他に呼ばれないため、spy で握りつぶしても影響なし。
      const setItemSpy = vi
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementation(function (this: Storage, key: string, _value: string) {
          if (this === localStorage && key === 'peco-recent-files') {
            throw new DOMException('quota exceeded', 'QuotaExceededError');
          }
        });

      // 警告ログは抑制 (ノイズ回避)
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { result } = renderHook(() => useRecentFiles());

      // 期待動作: setItem は呼ばれた (試みた) が、例外が出たので sessionStorage は維持される
      expect(setItemSpy).toHaveBeenCalledWith(
        'peco-recent-files',
        JSON.stringify(['/quota.pdf']),
      );
      expect(sessionStorage.getItem('peco-recent-files')).toBe(
        JSON.stringify(['/quota.pdf']),
      );
      // local 側は書けていないので null のまま
      expect(localStorage.getItem('peco-recent-files')).toBeNull();
      // UI 状態は空 (local が無いので saved=null パス)
      expect(result.current.recentFiles).toEqual([]);
      // 失敗の警告ログが出ている
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe('#37: 既存挙動の維持 (移行成功パス)', () => {
    it('session に値があり local が空なら、session を local へ移行して session は破棄される', () => {
      sessionStorage.setItem('peco-recent-files', JSON.stringify(['/migrated.pdf']));

      const { result } = renderHook(() => useRecentFiles());

      expect(localStorage.getItem('peco-recent-files')).toBe(
        JSON.stringify(['/migrated.pdf']),
      );
      expect(sessionStorage.getItem('peco-recent-files')).toBeNull();
      expect(result.current.recentFiles).toEqual(['/migrated.pdf']);
    });

    it('local に既に値がある場合、session 側の値は優先せず破棄する', () => {
      // どちらも真実候補とみなされる状態を作らないため、local 優先で session 破棄
      sessionStorage.setItem('peco-recent-files', JSON.stringify(['/session.pdf']));
      localStorage.setItem('peco-recent-files', JSON.stringify(['/local.pdf']));

      const { result } = renderHook(() => useRecentFiles());

      expect(localStorage.getItem('peco-recent-files')).toBe(
        JSON.stringify(['/local.pdf']),
      );
      expect(sessionStorage.getItem('peco-recent-files')).toBeNull();
      expect(result.current.recentFiles).toEqual(['/local.pdf']);
    });

    it('local も session も空なら何も起こらない (recentFiles=[])', () => {
      const { result } = renderHook(() => useRecentFiles());
      expect(result.current.recentFiles).toEqual([]);
      expect(localStorage.getItem('peco-recent-files')).toBeNull();
      expect(sessionStorage.getItem('peco-recent-files')).toBeNull();
    });

    it('peco-recent-files-updated イベントで再ロードする', () => {
      localStorage.setItem('peco-recent-files', JSON.stringify(['/initial.pdf']));
      const { result, rerender } = renderHook(() => useRecentFiles());
      expect(result.current.recentFiles).toEqual(['/initial.pdf']);

      // 外部 (useFileOperations 等) から localStorage を更新してイベントを発火
      localStorage.setItem('peco-recent-files', JSON.stringify(['/added.pdf', '/initial.pdf']));
      window.dispatchEvent(new CustomEvent('peco-recent-files-updated'));
      rerender();

      expect(result.current.recentFiles).toEqual(['/added.pdf', '/initial.pdf']);
    });

    it('不正 JSON や型違反値は空配列にフォールバックする', () => {
      localStorage.setItem('peco-recent-files', 'not-json{{{');
      const { result: r1 } = renderHook(() => useRecentFiles());
      expect(r1.current.recentFiles).toEqual([]);

      localStorage.setItem('peco-recent-files', JSON.stringify({ foo: 1 }));
      const { result: r2 } = renderHook(() => useRecentFiles());
      expect(r2.current.recentFiles).toEqual([]);

      localStorage.setItem('peco-recent-files', JSON.stringify([1, 'a']));
      const { result: r3 } = renderHook(() => useRecentFiles());
      expect(r3.current.recentFiles).toEqual([]);
    });
  });
});
