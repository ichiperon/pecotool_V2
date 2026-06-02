import React from 'react';

interface RibbonTabProps {
  id: string;
  active: boolean;
  onClick: () => void;
  'data-tour'?: string;
  children: React.ReactNode;
}

export const RibbonTab: React.FC<RibbonTabProps> = ({
  id,
  active,
  onClick,
  'data-tour': dataTour,
  children,
}) => {
  return (
    <button
      type="button"
      role="tab"
      id={`ribbon-tab-${id}`}
      aria-selected={active}
      aria-controls={`ribbon-panel-${id}`}
      className={`ribbon-tab${active ? ' ribbon-tab--active' : ''}`}
      onClick={onClick}
      data-tour={dataTour}
    >
      {children}
    </button>
  );
};
