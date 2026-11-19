import * as React from 'react';
import { clsx } from 'clsx';

type ButtonVariant = 'default' | 'secondary' | 'outline' | 'ghost' | 'link' | 'destructive';
type ButtonSize = 'sm' | 'md' | 'icon';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/**
 * shadcn/ui Button 的注入版。
 * 颜色走 .bili-button-* 自定义类，内部全部引用当前 VS Code 主题变量。
 */
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'md', type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={clsx('bili-button', `bili-button-${variant}`, `bili-button-${size}`, className)}
      {...props}
    />
  ),
);
Button.displayName = 'Button';

export { Button };
