/* eslint-disable react-refresh/only-export-components */
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils.js';

export const selectVariants = cva(
  'flex w-full appearance-none rounded-md border text-base text-[var(--text-primary)] shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        default:
          'border-border bg-surface-2 focus-visible:border-border-accent focus-visible:ring-[var(--bg-accent)]',
        error:
          'border-red-500/50 bg-red-500/10 text-red-200 focus-visible:border-red-500 focus-visible:ring-red-500/30',
        filled:
          'border-transparent bg-surface-1 focus-visible:border-border-accent focus-visible:ring-[var(--bg-accent)]',
      },
      selectSize: {
        default: 'h-[40px] pl-3.5 pr-10 py-2 text-sm',
        sm: 'h-8 pl-2.5 pr-8 py-1 text-xs',
      },
    },
    defaultVariants: {
      variant: 'default',
      selectSize: 'default',
    },
  },
);

export interface SelectProps
  extends
    Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'>,
    VariantProps<typeof selectVariants> {
  containerClassName?: string;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, containerClassName, variant, selectSize, children, ...props }, ref) => {
    return (
      <div className={cn('relative flex min-w-0 w-full items-center', containerClassName)}>
        <select
          className={cn('min-w-0', selectVariants({ variant, selectSize }), className)}
          ref={ref}
          {...props}
        >
          {children}
        </select>
        <div
          className={cn(
            'pointer-events-none absolute inset-y-0 right-0 flex items-center justify-center text-[var(--text-secondary)]',
            selectSize === 'sm' ? 'w-8' : 'w-10',
          )}
          aria-hidden="true"
        >
          <i className={cn('ti ti-chevron-down', selectSize === 'sm' ? 'text-sm' : 'text-base')} />
        </div>
      </div>
    );
  },
);
Select.displayName = 'Select';
