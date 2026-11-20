import * as React from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';
import { clsx } from 'clsx';

/**
 * shadcn/ui Slider 的注入版。
 * 结构沿用 shadcn（Root / Track / Range / Thumb），样式走 .bili-slider-* 自定义类，
 * 竖直模式由 Radix 的 orientation="vertical" 处理。
 */
const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Root ref={ref} className={clsx('bili-slider', className)} {...props}>
    <SliderPrimitive.Track className="bili-slider-track">
      <SliderPrimitive.Range className="bili-slider-range" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb className="bili-slider-thumb" />
  </SliderPrimitive.Root>
));
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
