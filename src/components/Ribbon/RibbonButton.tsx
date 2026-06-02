import React from 'react';

interface RibbonButtonProps {
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  title?: string;
  className?: string;
  size?: 'large' | 'small';
  'aria-pressed'?: 'true' | 'false';
  'data-tour'?: string;
  children: React.ReactNode;
}

export const RibbonButton: React.FC<RibbonButtonProps> = ({
  onClick,
  disabled,
  title,
  className,
  size = 'small',
  'aria-pressed': ariaPressed,
  'data-tour': dataTour,
  children,
}) => {
  const sizeClass = size === 'large' ? 'ribbon-button--large' : 'ribbon-button--small';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`ribbon-btn ${sizeClass}${className ? ` ${className}` : ''}`}
      aria-pressed={ariaPressed}
      data-tour={dataTour}
    >
      {children}
    </button>
  );
};
