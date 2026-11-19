import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { clsx } from 'clsx';

/**
 * shadcn/ui Switch 的注入版。
 * 尺寸、轨道和滑块颜色走 .bili-switch-* 自定义类，内部引用当前 VS Code 主题变量。
 */
const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root ref={ref} className={clsx('bili-switch', className)} {...props}>
    <SwitchPrimitive.Thumb className="bili-switch-thumb" />
  </SwitchPrimitive.Root>
));
Switch.displayName = SwitchPrimitive.Root.displayName;

export { Switch };
