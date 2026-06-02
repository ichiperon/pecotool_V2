import React from 'react';

interface RibbonButtonProps {
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  title?: string;
  className?: string;
  'aria-pressed'?: 'true' | 'false';
  'data-tour'?: string;
  children: React.ReactNode;
}

export const RibbonButton: React.FC<RibbonButtonProps> = ({
  onClick,
  disabled,
  title,
  className,
  'aria-pressed': ariaPressed,
  'data-tour': dataTour,
  children,
}) => {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`ribbon-btn${className ? ` ${className}` : ''}`}
      aria-pressed={ariaPressed}
      data-tour={dataTour}
    >
      {children}
    </button>
  );
};
