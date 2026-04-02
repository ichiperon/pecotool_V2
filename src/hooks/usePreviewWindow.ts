import { useState, useEffect, useMemo, useCallback } from 'react';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getAllWindows } from '@tauri-apps/api/window';
import { emit, listen } from '@tauri-apps/api/event';
import { usePecoStore } from '../store/pecoStore';

export function usePreviewWindow() {
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const { document, currentPageIndex } = usePecoStore();
  const currentPage = document?.pages.get(currentPageIndex);

  const previewText = useMemo(() => {
    if (!currentPage?.textBlocks) return "";
    const sorted = [...currentPage.textBlocks].sort((a, b) => a.order - b.order);
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
  }, [currentPage]);

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
      console.error(e);
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
      console.error(e);
    }
  }, [isPreviewOpen, initPreviewWindow]);

  useEffect(() => {
    emit('preview-update', previewText).catch(e => console.error(e));
  }, [previewText]);

  useEffect(() => {
    const setupListener = async () => {
      return await listen('request-preview', () => {
        emit('preview-update', previewText).catch(e => console.error(e));
      });
    };
    let unlistenFn: (() => void) | undefined;
    setupListener().then(fn => unlistenFn = fn);
    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, [previewText]);

  return { isPreviewOpen, togglePreviewWindow, initPreviewWindow };
}
