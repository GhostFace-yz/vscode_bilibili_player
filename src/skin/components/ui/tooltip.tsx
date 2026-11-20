import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { clsx } from 'clsx';

/**
 * shadcn/ui Tooltip 的注入版。
 * 主题变量挂在 .monaco-workbench 上，Portal 必须挂进 HUD，否则会丢主题色。
 */
const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 8, ...props }, ref) => {
  const container =
    typeof document === 'undefined' ? undefined : document.getElementById('bili-skin-hud') ?? undefined;
  return (
    <TooltipPrimitive.Portal container={container}>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={clsx('bili-tooltip', className)}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
});
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
