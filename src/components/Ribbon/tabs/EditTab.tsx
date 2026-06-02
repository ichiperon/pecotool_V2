import React from 'react';
import {
  RotateCcw, RotateCw, SquareCheckBig, RemoveFormatting, Replace,
  Plus, Scissors, Spline, Group, Eraser, Trash2
} from 'lucide-react';
import { RibbonGroup } from '../RibbonGroup';
import { RibbonButton } from '../RibbonButton';
import type { PageData } from '../../../types';

interface EditTabProps {
  isFileLoaded: boolean;
  currentPage: PageData | undefined;
  undoStackLength: number;
  redoStackLength: number;
  selectedIdsCount: number;
  isDrawingMode: boolean;
  isSplitMode: boolean;
  isCurveMode: boolean;
  isOcrRunning: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSelectAllText: () => void;
  onRemoveSpaces: () => void;
  onOpenReplace: () => void;
  onToggleDrawing: () => void;
  onToggleSplit: () => void;
  onToggleCurve: () => void;
  onGroup: () => void;
  onDeduplicate: () => void;
  onDelete: () => void;
}

export const EditTab: React.FC<EditTabProps> = (props) => {
  return (
    <>
      <RibbonGroup title="履歴">
        <RibbonButton
          onClick={props.onUndo}
          disabled={props.undoStackLength === 0}
          title="元に戻す (Ctrl+Z)"
        >
          <RotateCcw size={14} /><span>Undo</span>
        </RibbonButton>
        <RibbonButton
          onClick={props.onRedo}
          disabled={props.redoStackLength === 0}
          title="やり直し (Ctrl+Y)"
        >
          <RotateCw size={14} /><span>Redo</span>
        </RibbonButton>
      </RibbonGroup>

      <RibbonGroup title="選択">
        <RibbonButton
          onClick={props.onSelectAllText}
          disabled={!props.currentPage || props.currentPage.textBlocks.length === 0}
          title="テキスト全選択"
        >
          <SquareCheckBig size={14} /><span>全選択</span>
        </RibbonButton>
      </RibbonGroup>

      <RibbonGroup title="テキスト">
        <RibbonButton
          onClick={props.onRemoveSpaces}
          disabled={props.selectedIdsCount === 0}
          title="スペース削除 (Ctrl+Shift+Space)"
        >
          <RemoveFormatting size={14} /><span>スペース削除</span>
        </RibbonButton>
        <RibbonButton
          onClick={props.onOpenReplace}
          disabled={!props.isFileLoaded || props.isOcrRunning}
          title={props.isOcrRunning ? '検索と置換 (OCR実行中は無効)' : '検索と置換 (Ctrl+H)'}
        >
          <Replace size={14} /><span>検索置換</span>
        </RibbonButton>
      </RibbonGroup>

      <RibbonGroup title="構造">
        <RibbonButton
          onClick={props.onToggleDrawing}
          disabled={!props.isFileLoaded}
          className={props.isDrawingMode ? 'active' : ''}
          title="BB追加"
        >
          <Plus size={14} /><span>追加</span>
        </RibbonButton>
        <RibbonButton
          onClick={props.onToggleSplit}
          disabled={!props.isFileLoaded}
          className={props.isSplitMode ? 'active' : ''}
          title="BB分割"
        >
          <Scissors size={14} /><span>分割</span>
        </RibbonButton>
        <RibbonButton
          onClick={props.onToggleCurve}
          disabled={!props.isFileLoaded}
          className={props.isCurveMode ? 'active' : ''}
          aria-pressed={props.isCurveMode ? 'true' : 'false'}
          title="湾曲モード"
        >
          <Spline size={14} /><span>湾曲</span>
        </RibbonButton>
        <RibbonButton
          onClick={props.onGroup}
          disabled={props.selectedIdsCount < 2}
          title="グループ化"
        >
          <Group size={14} /><span>グループ化</span>
        </RibbonButton>
        <RibbonButton
          onClick={props.onDeduplicate}
          title="重複削除"
        >
          <Eraser size={14} /><span>重複削除</span>
        </RibbonButton>
        <RibbonButton
          onClick={props.onDelete}
          disabled={props.selectedIdsCount === 0}
          className="danger"
          title="削除"
        >
          <Trash2 size={14} /><span>削除</span>
        </RibbonButton>
      </RibbonGroup>
    </>
  );
};
