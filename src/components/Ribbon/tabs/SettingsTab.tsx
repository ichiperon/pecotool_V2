import React from 'react';
import { RibbonGroup } from '../RibbonGroup';
import { RibbonButton } from '../RibbonButton';
import { UPDATER_ENABLED } from '../../../hooks/useAppUpdater';

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
        {/* UPDATER_ENABLED=false の間 (pubkey 未設定) はボタンを出さない。
            押しても成否のフィードバックが無く混乱を招くため。 */}
        {UPDATER_ENABLED && (
          <RibbonButton onClick={props.onCheckUpdate} title="アップデート確認" size="large">
            <span>アップデート確認</span>
          </RibbonButton>
        )}
      </RibbonGroup>
    </>
  );
};
