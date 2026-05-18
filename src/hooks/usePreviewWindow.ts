import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getAllWindows } from '@tauri-apps/api/window';
import { emit, listen } from '@tauri-apps/api/event';
import { usePecoStore, selectCurrentPageTextBlocks } from '../store/pecoStore';
import { logUnlessTauriWindowNotFound } from '../utils/tauriWindowErrors';

export function usePreviewWindow() {
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  // PageData 全体ではなく textBlocks のみを購読する。
  // isDirty / thumbnail / isTextExtracted など textBlocks 以外のフィールド更新で
  // previewText が recompute されるのを防ぐ (issue #66)。
  const textBlocks = usePecoStore(selectCurrentPageTextBlocks);

  const previewText = useMemo(() => {
    if (!textBlocks) return "";
    const sorted = [...textBlocks].sort((a, b) => a.order - b.order);
    let text = "";
    for (let i = 0; i < sorted.length; i++) {
      const curr = sorted[i];
      if (i > 0) {
        const prev = sorted[i - 1];
        const isVertical = prev.writingMode === 'vertical';
        if (!isVertical) {
          if (Math.abs(curr.bbox.y - prev.bbox.y) > prev.bbox.height * 0.5) text += "\n";
          else if (curr.bbox.x - (prev.bbox.x + prev.bbox.width) > prev.bbox.height) text += " ";
        } else {
          if (Math.abs(prev.bbox.x - curr.bbox.x) > prev.bbox.width * 0.5) text += "\n";
          else if (Math.abs(curr.bbox.y - (prev.bbox.y + prev.bbox.height)) > prev.bbox.width) text += " ";
        }
      }
      text += curr.text;
    }
    return text;
  }, [textBlocks]);

  // listen() の再登録を避けるため最新 previewText を ref に保持。
  // 編集 1 文字ごとに useEffect が走って Tauri IPC が 4 ラウンドトリップ発火するのを止める。
  const previewTextRef = useRef(previewText);
  previewTextRef.current = previewText;

  const initPreviewWindow = useCallback(async () => {
    try {
      const windows = await getAllWindows();
      let win = windows.find(w => w.label === 'preview-window');
      if (!win) {
        win = new WebviewWindow('preview-window', {
          url: '/#preview',
          title: 'テキストコピー プレビュー',
          width: 600,
          height: 800,
          visible: false
        });
      }
      return win;
    } catch (e) {
      logUnlessTauriWindowNotFound(e);
      return undefined;
    }
  }, []);

  const togglePreviewWindow = useCallback(async () => {
    try {
      const windows = await getAllWindows();
      let win = windows.find(w => w.label === 'preview-window');
      if (win && isPreviewOpen) {
        await win.hide();
        setIsPreviewOpen(false);
      } else {
        if (!win) {
          win = await initPreviewWindow();
        }
        if (win) {
          setIsPreviewOpen(true);
          await win.show();
          await win.setFocus();
        }
      }
    } catch (e) {
      logUnlessTauriWindowNotFound(e);
    }
  }, [isPreviewOpen, initPreviewWindow]);

  useEffect(() => {
    // preview ウィンドウ未開時は emit しない。
    // 編集 1 文字ごとに Tauri IPC が走るのを防ぐ (issue #66)。
    // 開いた瞬間は preview ウィンドウ側が request-preview を emit して最新値を取得する。
    if (!isPreviewOpen) return;
    emit('preview-update', previewText).catch(logUnlessTauriWindowNotFound);
  }, [previewText, isPreviewOpen]);

  useEffect(() => {
    let cancelled = false;
    let unlistenFn: (() => void) | undefined;
    const setupListener = async () => {
      const un1 = await listen('request-preview', () => {
        emit('preview-update', previewTextRef.current).catch(logUnlessTauriWindowNotFound);
      });
      const un2 = await listen('preview-hidden', () => {
        setIsPreviewOpen(false);
      });
      return () => { un1(); un2(); };
    };
    setupListener().then(fn => {
      if (cancelled) { fn(); return; }
      unlistenFn = fn;
    }).catch(logUnlessTauriWindowNotFound);
    return () => {
      cancelled = true;
      unlistenFn?.();
    };
  }, []);

  return { isPreviewOpen, togglePreviewWindow };
}
