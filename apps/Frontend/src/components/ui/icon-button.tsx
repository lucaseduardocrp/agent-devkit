/* eslint-disable react-refresh/only-export-components */
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils.js';

export const iconButtonVariants = cva(
  'inline-flex items-center justify-center shrink-0 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default:
          'bg-[var(--fill-accent)] text-[#091624] hover:bg-[var(--fill-accent-hover)] focus-visible:ring-[var(--fill-accent)]',
        destructive:
          'bg-[var(--fill-danger)] text-white hover:opacity-90 focus-visible:ring-[var(--fill-danger)]',
        outline:
          'border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-primary)] hover:bg-[var(--fill-ghost-hover)] hover:border-[var(--border-strong)]',
        secondary:
          'bg-[var(--surface-2)] text-[var(--text-primary)] border border-[var(--border)] hover:border-[var(--border-strong)]',
        ghost:
          'bg-transparent text-[var(--text-secondary)] hover:bg-[var(--fill-ghost-hover)] hover:text-[var(--text-primary)]',
        subtle:
          'border border-[var(--border)] bg-[var(--surface-1)] text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]',
      },
      size: {
        default: 'h-[40px] w-[40px] text-base',
        sm: 'h-8 w-8 text-sm',
        xs: 'h-6 w-6 text-xs',
        lg: 'h-12 w-12 text-lg',
      },
    },
    defaultVariants: {
      variant: 'ghost',
      size: 'default',
    },
  },
);

export interface IconButtonProps
  extends
    Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'>,
    VariantProps<typeof iconButtonVariants> {
  readonly icon?: React.ReactNode;
  readonly label: string;
  readonly isLoading?: boolean;
  readonly children?: React.ReactNode;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      className,
      variant = 'ghost',
      size = 'default',
      icon,
      label,
      isLoading = false,
      disabled,
      children,
      title,
      type = 'button',
      ...props
    },
    ref,
  ) => {
    return (
      <button
        ref={ref}
        type={type}
        aria-label={label}
        title={title ?? label}
        disabled={disabled || isLoading}
        className={cn(iconButtonVariants({ variant, size }), className)}
        {...props}
      >
        {isLoading ? (
          <i className="ti ti-loader-2 animate-spin text-current" aria-hidden="true" />
        ) : (
          (icon ?? children)
        )}
      </button>
    );
  },
);
IconButton.displayName = 'IconButton';
