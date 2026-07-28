import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '@/lib/utils';
import { cva, type VariantProps } from 'class-variance-authority';

/**
 * The application's only Button.
 *
 * This file previously carried a vendored variant set referencing tokens the
 * project never defined — `--button-outline`, `border-primary-border`,
 * `border-secondary-border`, and `hover-elevate` / `active-elevate-2` utility
 * classes. None exist in `src/index.css`, so every page importing this
 * component rendered buttons with NO hover state at all and, on the `outline`
 * variant, a border colour falling back to `currentColor`. That is why a
 * second hand-rolled Button grew up alongside it in `src/components/ui.tsx`:
 * someone hit the breakage and routed around it rather than fixing it.
 *
 * The variants below are the working ones from that hand-rolled set, moved
 * here and expressed as CVA — so there is one implementation, `buttonVariants`
 * keeps working for the components that compose it (alert-dialog, pagination,
 * calendar), and every token resolves. `ui.tsx` now re-exports this file.
 *
 * Sizes are floors (`min-h-*`) rather than fixed heights so a button never
 * clips its own label, and `sm` sits at 36px instead of 32px to stay a usable
 * touch target on a phone.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold tracking-[-0.005em] transition-all ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ' +
    'disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
        outline: 'border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'min-h-10 px-5 py-2',
        sm: 'min-h-9 rounded-lg px-3.5 text-[13px]',
        lg: 'min-h-11 rounded-lg px-7 text-[15px]',
        icon: 'min-h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
