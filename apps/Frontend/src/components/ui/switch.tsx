import * as React from 'react';
import { cn } from '../../lib/utils.js';

export type SwitchProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'>;

/**
 * An on/off toggle. A real checkbox underneath (keyboard, forms and screen readers work), drawn
 * as a track and thumb. Give it a label: wrap it in a `<label>` or pass `aria-label`.
 */
export function Switch({ className, ...props }: SwitchProps) {
  return (
    <span className={cn('relative inline-flex h-5 w-9 shrink-0', className)}>
      <input
        type="checkbox"
        role="switch"
        className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        {...props}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-full border border-[var(--border-strong)] bg-[var(--surface-2)] transition-colors peer-checked:border-transparent peer-checked:bg-[var(--fill-accent)] peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--fill-accent)] peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-[var(--surface-1)] peer-disabled:opacity-50"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-[3px] top-[3px] h-3.5 w-3.5 rounded-full bg-[var(--text-secondary)] transition-transform peer-checked:translate-x-4 peer-checked:bg-[#091624]"
      />
    </span>
  );
}
