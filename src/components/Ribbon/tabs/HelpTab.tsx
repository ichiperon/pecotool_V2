import React from 'react';
import { RibbonGroup } from '../RibbonGroup';
import { RibbonButton } from '../RibbonButton';

interface HelpTabProps {
  onShowTour: () => void;
  onShowShortcuts: () => void;
  onShowUsage: () => void;
  onShowVersion: () => void;
}

export const HelpTab: React.FC<HelpTabProps> = (props) => {
  return (
    <>
      <RibbonGroup title="学習">
        <RibbonButton onClick={props.onShowTour} title="チュートリアルを表示">
          チュートリアル
        </RibbonButton>
        <RibbonButton onClick={props.onShowShortcuts} title="ショートカットキー一覧">
          ショートカット
        </RibbonButton>
        <RibbonButton onClick={props.onShowUsage} title="ツールの使い方">
          ツールの使い方
        </RibbonButton>
      </RibbonGroup>

      <RibbonGroup title="情報">
        <RibbonButton onClick={props.onShowVersion} title="バージョン情報" size="large">
          <span>バージョン情報</span>
        </RibbonButton>
      </RibbonGroup>
    </>
  );
};
