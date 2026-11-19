import * as React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from '@ricons/tabler';
import { clsx } from 'clsx';

/**
 * shadcn/ui Select 的注入版：
 * - 结构/交互沿用 shadcn（Radix Select + Trigger/Content/Item）
 * - 样式使用 .bili-select-* 自定义类，避免 Tailwind 前缀与 Portal 作用域问题
 */
const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger ref={ref} className={clsx('bili-select-trigger', className)} {...props}>
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown width={13} height={13} />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = 'popper', ...props }, ref) => {
  // 主题变量在 .monaco-workbench 上；Portal 不能挂到 body，否则丢主题。
  const container =
    typeof document === 'undefined'
      ? undefined
      : document.getElementById('bili-skin-hud') ?? undefined;
  return (
    <SelectPrimitive.Portal container={container}>
      <SelectPrimitive.Content
        ref={ref}
        className={clsx('bili-select-content', className)}
        position={position}
        sideOffset={6}
        style={{ zIndex: 2147483001 }}
        {...props}
      >
        {/* 不使用 SelectPrimitive.Viewport：它会注入一个带 dangerouslySetInnerHTML 的 <style>，
            在 VS Code 的 require-trusted-types-for 'script' 下会直接抛错。 */}
        <div className="bili-select-viewport">{children}</div>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item ref={ref} className={clsx('bili-select-item', className)} {...props}>
    <span className="bili-select-item-indicator">
      <SelectPrimitive.ItemIndicator>
        <Check width={13} height={13} />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectItem,
};
