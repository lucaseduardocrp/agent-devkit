/* eslint-disable react-refresh/only-export-components */
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils.js';

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default:
          'bg-[var(--fill-accent)] text-[#091624] hover:bg-[var(--fill-accent-hover)] focus-visible:ring-[var(--fill-accent)]',
        destructive:
          'bg-[var(--fill-danger)] text-white hover:opacity-90 focus-visible:ring-[var(--fill-danger)]',
        outline:
          'border border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text-primary)] hover:bg-[var(--fill-ghost-hover)]',
        secondary:
          'bg-[var(--surface-2)] text-[var(--text-primary)] border border-[var(--border)] hover:border-[var(--border-strong)]',
        ghost:
          'bg-transparent text-[var(--text-secondary)] hover:bg-[var(--fill-ghost-hover)] hover:text-[var(--text-primary)]',
        link: 'text-[var(--text-accent)] underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-[40px] px-4 py-2 text-sm font-semibold',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-14 rounded-md px-7 text-lg',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  readonly isLoading?: boolean;
  readonly leftIcon?: React.ReactNode;
  readonly rightIcon?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      isLoading = false,
      leftIcon,
      rightIcon,
      disabled,
      children,
      ...props
    },
    ref,
  ) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled || isLoading}
        {...props}
      >
        {isLoading ? <i className="ti ti-loader animate-spin" aria-hidden="true" /> : leftIcon}
        {children}
        {!isLoading && rightIcon}
      </button>
    );
  },
);
Button.displayName = 'Button';
