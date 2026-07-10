import React from 'react';

interface RibbonButtonProps {
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  title?: string;
  className?: string;
  size?: 'large' | 'small';
  keepLabelOnCompact?: boolean;
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
  keepLabelOnCompact = false,
  'aria-pressed': ariaPressed,
  'data-tour': dataTour,
  children,
}) => {
  const sizeClass = size === 'large' ? 'ribbon-button--large' : 'ribbon-button--small';
  const hasIcon = React.Children.toArray(children).some(
    (child) => React.isValidElement(child) && child.type !== 'span',
  );
  const contentClass = hasIcon ? 'ribbon-btn--has-icon' : 'ribbon-btn--text-only';
  const compactLabelClass = keepLabelOnCompact ? ' ribbon-btn--keep-label' : '';
  const labelledChildren = React.Children.map(children, (child) => {
    if (typeof child === 'string' || typeof child === 'number') {
      return <span className="ribbon-btn-label">{child}</span>;
    }
    if (React.isValidElement<{ className?: string }>(child) && child.type === 'span') {
      const existingClassName = child.props.className;
      return React.cloneElement(child, {
        className: existingClassName
          ? `${existingClassName} ribbon-btn-label`
          : 'ribbon-btn-label',
      });
    }
    return child;
  });

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={`ribbon-btn ${sizeClass} ${contentClass}${compactLabelClass}${className ? ` ${className}` : ''}`}
      aria-pressed={ariaPressed}
      data-tour={dataTour}
    >
      {labelledChildren}
    </button>
  );
};
