import * as React from 'react';
import { cn } from '@/lib/utils';
import { cva, type VariantProps } from 'class-variance-authority';

/**
 * The application's only Badge.
 *
 * Same story as button.tsx: the vendored version referenced an undefined
 * `--badge-outline` and a `hover-elevate` class that does not exist, so the
 * `outline` variant fell back to `currentColor`. The variants below come from
 * the working hand-rolled set in `ui.tsx`, which `ui.tsx` now re-exports.
 *
 * Tinted rather than solid fills (`bg-primary/20 text-primary`): on a dark
 * surface a solid badge shouts louder than the number it labels. The `success`
 * variant is carried over — the app uses it heavily and stock shadcn has no
 * equivalent, which was one of the two reasons the fork existed.
 */
const badgeVariants = cva(
  // Whitespace-nowrap: badges should never wrap.
  'whitespace-nowrap inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors ' +
    'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary/20 text-primary',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive/20 text-destructive',
        success: 'border-transparent bg-success/20 text-success',
        outline: 'border-border text-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
