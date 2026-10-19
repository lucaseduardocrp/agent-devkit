/* eslint-disable react-refresh/only-export-components */
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils.js';

export const inputVariants = cva(
  'flex w-full rounded-md border text-base text-[var(--text-primary)] shadow-sm transition-colors file:border-0 file:bg-transparent file:text-base file:font-medium placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        default:
          'border-border bg-surface-2 focus-visible:border-border-accent focus-visible:ring-[var(--bg-accent)]',
        error:
          'border-red-500/50 bg-red-500/10 text-red-200 placeholder:text-red-400/60 focus-visible:border-red-500 focus-visible:ring-red-500/30',
        filled:
          'border-transparent bg-surface-1 focus-visible:border-border-accent focus-visible:ring-[var(--bg-accent)]',
      },
      inputSize: {
        default: 'h-[40px] px-3.5 py-2 text-sm',
        sm: 'h-8 px-2.5 py-1 text-xs',
      },
    },
    defaultVariants: {
      variant: 'default',
      inputSize: 'default',
    },
  },
);

export interface InputProps
  extends
    Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'>,
    VariantProps<typeof inputVariants> {
  readonly leftIcon?: React.ReactNode;
  readonly rightIcon?: React.ReactNode;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, variant, inputSize, type, leftIcon, rightIcon, ...props }, ref) => {
    const inputElement = (
      <input
        type={type}
        className={cn(
          inputVariants({ variant, inputSize }),
          leftIcon && 'pl-11',
          rightIcon && 'pr-11',
          className,
        )}
        ref={ref}
        {...props}
      />
    );

    if (!leftIcon && !rightIcon) {
      return inputElement;
    }

    return (
      <div className="relative flex w-full items-center">
        {leftIcon && (
          <div className="pointer-events-none absolute left-3.5 flex items-center justify-center text-[var(--text-secondary)]">
            {leftIcon}
          </div>
        )}
        {inputElement}
        {rightIcon && (
          <div className="pointer-events-none absolute right-3.5 flex items-center justify-center text-[var(--text-secondary)]">
            {rightIcon}
          </div>
        )}
      </div>
    );
  },
);
Input.displayName = 'Input';
