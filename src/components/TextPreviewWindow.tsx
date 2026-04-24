import { useState, useEffect } from "react";
import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy } from "lucide-react";
import { logUnlessTauriWindowNotFound } from "../utils/tauriWindowErrors";

export function TextPreviewWindow() {
  const [text, setText] = useState<string>("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // アンマウント済みフラグ（非同期setup完了前にアンマウントされた場合に即解除）
    let unmounted = false;
    const unlisteners: Array<() => void> = [];

    const setupListener = async () => {
      const waitUnlisten = await listen<string>('preview-update', (event) => {
        setText(event.payload);
      });
      if (unmounted) { waitUnlisten(); return; }
      unlisteners.push(waitUnlisten);

      // バツボタンを押したときにウインドウを破壊せず非表示にする
      const win = getCurrentWindow();
      const closeUnlisten = await win.onCloseRequested((event) => {
        event.preventDefault();
        win.hide().catch(logUnlessTauriWindowNotFound);
        emit('preview-hidden').catch(logUnlessTauriWindowNotFound);
      });
      if (unmounted) { closeUnlisten(); return; }
      unlisteners.push(closeUnlisten);

      // Request initial text from main window
      await emit('request-preview');
    };

    setupListener().catch(() => {});

    return () => {
      unmounted = true;
      unlisteners.forEach(fn => fn());
    };
  }, []);

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', backgroundColor: '#f8fafc', overflow: 'hidden' }}>
      <div style={{ height: '48px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px', borderBottom: '1px solid #e2e8f0' }}>
        <span style={{ fontWeight: 'bold', color: '#334155' }}>コピペ専用 プレビューウィンドウ</span>
        <button 
           onClick={handleCopy} 
           style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px', background: copied ? '#10b981' : '#3b82f6', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
        >
          <Copy size={16} />
          {copied ? 'コピーしました！' : '全てコピー'}
        </button>
      </div>
      <textarea 
        readOnly
        value={text}
        placeholder="メインウィンドウでファイルを開き、テキストを編集するとここにリアルタイムで反映されます…"
        style={{ flex: 1, padding: '16px', fontSize: '15px', resize: 'none', border: 'none', outline: 'none', lineHeight: 1.6 }}
      />
    </div>
  );
}
