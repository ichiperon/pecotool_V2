import type { HelpModalKind } from '../hooks/useDialogState';

interface Props {
  helpModal: HelpModalKind;
  onClose: () => void;
}

export function HelpModal({ helpModal, onClose }: Props) {
  if (!helpModal) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          {helpModal === 'shortcuts' && 'ショートカットキー一覧'}
          {helpModal === 'usage' && 'ツールの使い方'}
          {helpModal === 'version' && 'バージョン情報'}
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {helpModal === 'shortcuts' && (
            <div className="help-grid">
              <div className="modal-section-title">ファイル操作</div>
              <div className="help-item"><kbd>Ctrl</kbd>+<kbd>O</kbd><span>開く</span></div>
              <div className="help-item"><kbd>Ctrl</kbd>+<kbd>S</kbd><span>保存</span></div>
              <div className="help-item"><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd><span>別名で保存</span></div>
              <div className="help-divider" />
              <div className="modal-section-title">編集</div>
              <div className="help-item"><kbd>Ctrl</kbd>+<kbd>Z</kbd><span>元に戻す</span></div>
              <div className="help-item"><kbd>Ctrl</kbd>+<kbd>Y</kbd><span>やり直し</span></div>
              <div className="help-item"><kbd>Ctrl</kbd>+<kbd>C</kbd><span>BBをコピー（非編集時）</span></div>
              <div className="help-item"><kbd>Ctrl</kbd>+<kbd>V</kbd><span>BBを貼り付け（非編集時）</span></div>
              <div className="help-item"><kbd>Delete</kbd><span>選択BBを削除（非編集時）</span></div>
              <div className="help-divider" />
              <div className="modal-section-title">BB操作</div>
              <div className="help-item"><kbd>Ctrl</kbd>+<kbd>F10</kbd><span>BB追加モード</span></div>
              <div className="help-item"><kbd>Ctrl</kbd>+<kbd>F11</kbd><span>BB分割モード</span></div>
              <div className="help-item"><kbd>Ctrl</kbd>+<kbd>F12</kbd><span>選択BBをグループ化</span></div>
              <div className="help-item"><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd><span>選択BB内のスペース削除</span></div>
              <div className="help-divider" />
              <div className="modal-section-title">表示</div>
              <div className="help-item"><kbd>Ctrl</kbd>+<kbd>0</kbd><span>画面にフィット</span></div>
              <div className="help-item"><kbd>Ctrl</kbd>/<kbd>Alt</kbd>+<kbd>ホイール</kbd><span>ズーム</span></div>
              <div className="help-item"><kbd>Space</kbd>+<span>ドラッグ 画面移動（パン）</span></div>
              <div className="help-item"><kbd>Ctrl</kbd>+<kbd>F</kbd><span>テキスト検索</span></div>
            </div>
          )}
          {helpModal === 'usage' && (
            <div className="usage-guide">
              <div className="usage-section">
                <div className="usage-title">基本的な流れ</div>
                <ol className="usage-list">
                  <li>「ファイル → 開く」からPDFを読み込む</li>
                  <li>サムネイルウィンドウ（自動表示）でページを選択</li>
                  <li>PDFビュー上でBB（テキストブロック）を確認・編集</li>
                  <li>右パネルでBBのテキストを直接編集</li>
                  <li>「ファイル → 保存」で保存</li>
                </ol>
              </div>
              <div className="usage-section">
                <div className="usage-title">BBの選択</div>
                <ul className="usage-list">
                  <li>PDFビューまたは右パネルのBBをクリックで選択</li>
                  <li><kbd>Ctrl</kbd>+クリック で複数選択</li>
                  <li><kbd>Shift</kbd>+クリック で範囲選択（右パネルのみ）</li>
                </ul>
              </div>
              <div className="usage-section">
                <div className="usage-title">BB操作</div>
                <ul className="usage-list">
                  <li><b>追加：</b> Ctrl+F10 で追加モード → PDFビュー上をドラッグ</li>
                  <li><b>移動・リサイズ：</b> 選択後にPDFビュー上でドラッグ</li>
                  <li><b>分割：</b> Ctrl+F11 で分割モード → BBをクリック</li>
                  <li><b>グループ化：</b> 複数選択して Ctrl+F12</li>
                  <li><b>並び順修正：</b> <kbd>Alt</kbd>+ドラッグで位置を移動して序列を更新</li>
                </ul>
              </div>
              <div className="usage-section">
                <div className="usage-title">テキスト編集</div>
                <ul className="usage-list">
                  <li>右パネルのBBカードをクリックして直接入力</li>
                  <li>OCRの誤認識スペースは「スペース削除」ボタンまたは Ctrl+Shift+Space で一括削除</li>
                  <li>Ctrl+↑↓ でBB間を移動</li>
                </ul>
              </div>
            </div>
          )}
          {helpModal === 'version' && (
            <div className="version-info">
              <div className="version-logo">PecoTool V2</div>
              <div className="version-number">バージョン 1.6.3</div>
              <div className="version-desc">PDF OCR 手動編集ツール</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
