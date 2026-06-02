import React from 'react';

interface RibbonGroupProps {
  title: string;
  children: React.ReactNode;
}

export const RibbonGroup: React.FC<RibbonGroupProps> = ({ title, children }) => {
  return (
    <div className="ribbon-group">
      <div className="ribbon-group-buttons">
        {children}
      </div>
      <div className="ribbon-group-title">{title}</div>
    </div>
  );
};
