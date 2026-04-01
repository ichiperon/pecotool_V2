import { X, Loader2 } from "lucide-react";
import { useState } from "react";

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

interface SaveDialogProps {
  isEstimating: boolean;
  estimatedSizes: { uncompressed: number; compressed: number } | null;
  onConfirm: (compression: 'none' | 'compressed' | 'rasterized', rasterizeQuality?: number) => void;
  onCancel: () => void;
  defaultCompression: 'none' | 'compressed' | 'rasterized';
  defaultRasterizeQuality?: number;
}

export function SaveDialog({
  isEstimating,
  estimatedSizes,
  onConfirm,
  onCancel,
  defaultCompression,
  defaultRasterizeQuality = 60,
}: SaveDialogProps) {
  const [compression, setCompression] = useState<'none' | 'compressed' | 'rasterized'>(defaultCompression);
  const [rasterizeQuality, setRasterizeQuality] = useState(defaultRasterizeQuality);

  return (
    <div className="save-dialog-backdrop">
      <div className="save-dialog">
        <div className="save-dialog-header">
          <h3>別名で保存</h3>
          <button onClick={onCancel} className="close-btn" title="閉じる">
            <X size={18} />
          </button>
        </div>

        <div className="save-dialog-content">
          <p className="save-dialog-title">PDFの保存形式を選択してください</p>

          <div className="compression-options">
            <label className={`compression-option ${compression === 'none' ? 'selected' : ''}`}>
              <input
                type="radio"
                name="compression"
                value="none"
                checked={compression === 'none'}
                onChange={() => setCompression('none')}
              />
              <div className="option-details">
                <span className="option-name">非圧縮 (通常)</span>
                <span className="option-size">
                  {isEstimating ? (
                    <Loader2 size={12} className="spin" />
                  ) : estimatedSizes ? (
                    formatFileSize(estimatedSizes.uncompressed)
                  ) : (
                    'サイズ推定不可'
                  )}
                </span>
                <p className="option-desc">パースや再編集の互換性が最も高い標準的な保存形式です。</p>
              </div>
            </label>

            <label className={`compression-option ${compression === 'compressed' ? 'selected' : ''}`}>
              <input
                type="radio"
                name="compression"
                value="compressed"
                checked={compression === 'compressed'}
                onChange={() => setCompression('compressed')}
              />
              <div className="option-details">
                <span className="option-name">圧縮 (Object Streams)</span>
                <span className="option-size">
                  {isEstimating ? (
                    <Loader2 size={12} className="spin" />
                  ) : estimatedSizes ? (
                    `${formatFileSize(estimatedSizes.compressed)} (${Math.round((1 - estimatedSizes.compressed / estimatedSizes.uncompressed) * 100)}% 削減)`
                  ) : (
                    'サイズ推定不可'
                  )}
                </span>
                <p className="option-desc">最適化を行いファイルサイズを削減します。</p>
              </div>
            </label>

            <label className={`compression-option ${compression === 'rasterized' ? 'selected' : ''}`}>
              <input
                type="radio"
                name="compression"
                value="rasterized"
                checked={compression === 'rasterized'}
                onChange={() => setCompression('rasterized')}
              />
              <div className="option-details">
                <span className="option-name" style={{ color: '#d97706' }}>高圧縮 (ラスタライズ)</span>
                <span className="option-size">
                  {isEstimating ? (
                    <Loader2 size={12} className="spin" />
                  ) : (
                    <span style={{ color: '#000' }}>推定不可 (実行時に計算)</span>
                  )}
                </span>
                <p className="option-desc">背景PDFを全ページ画像化(.jpg)し直して再構築します。<b style={{ color: '#dc2626' }}>※処理が重く、画質が低下します。</b></p>
                
                {compression === 'rasterized' && (
                  <div className="rasterize-quality-setting" style={{ marginTop: '8px', padding: '8px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '4px' }} onClick={(e) => e.stopPropagation()}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: '#991b1b' }}>
                      <span style={{ whiteSpace: 'nowrap' }}>JPEG画質:</span>
                      <input 
                        type="range" 
                        min="10" 
                        max="100" 
                        step="10" 
                        value={rasterizeQuality} 
                        onChange={(e) => setRasterizeQuality(parseInt(e.target.value, 10))} 
                        style={{ flex: 1, accentColor: '#dc2626' }}
                      />
                      <span style={{ fontWeight: 'bold', minWidth: '32px' }}>{rasterizeQuality}%</span>
                    </label>
                    <p style={{ fontSize: '10px', color: '#b91c1c', margin: '4px 0 0' }}>下げすぎると文字が読めなくなります。推奨は60%以上です。</p>
                  </div>
                )}
              </div>
            </label>
          </div>

          <p className="save-dialog-note">
            ※標準以下の圧縮では画像データは再圧縮されません。画質を落としてもサイズを減らしたい場合のみ高圧縮を使用してください。
          </p>
        </div>

        <div className="save-dialog-footer">
          <button onClick={onCancel} className="cancel-btn">
            キャンセル
          </button>
          <button onClick={() => onConfirm(compression, rasterizeQuality)} className="confirm-btn">
            保存する
          </button>
        </div>
      </div>
    </div>
  );
}
