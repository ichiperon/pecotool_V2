import React from 'react';
import { RibbonGroup } from '../RibbonGroup';
import { RibbonButton } from '../RibbonButton';

interface SettingsTabProps {
  onOpenLogFolder: () => void;
  onCheckUpdate: () => void;
}

export const SettingsTab: React.FC<SettingsTabProps> = (props) => {
  return (
    <>
      <RibbonGroup title="診断">
        <RibbonButton onClick={props.onOpenLogFolder} title="ログフォルダを開く">
          ログフォルダ
        </RibbonButton>
        <RibbonButton onClick={props.onCheckUpdate} title="アップデート確認">
          アップデート確認
        </RibbonButton>
      </RibbonGroup>
    </>
  );
};
