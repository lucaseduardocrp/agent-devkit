import * as React from 'react';
import { cn } from '../../lib/utils.js';

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  readonly shimmer?: boolean;
}

export function Skeleton({ className, shimmer = true, ...props }: SkeletonProps) {
  return (
    <div
      data-testid="skeleton"
      aria-hidden="true"
      className={cn('rounded-full bg-[#262626]', shimmer && 'animate-pulse', className)}
      {...props}
    />
  );
}

export function SkeletonText({
  lines = 3,
  className,
}: {
  readonly lines?: number;
  readonly className?: string;
}) {
  return (
    <div className={cn('space-y-2', className)} data-testid="skeleton-text" aria-hidden="true">
      {Array.from({ length: lines }).map((_, idx) => (
        <Skeleton
          key={`skeleton-line-${idx}`}
          className={cn('h-3 w-full rounded-full', idx === lines - 1 && 'w-3/4')}
        />
      ))}
    </div>
  );
}

export function SkeletonCard({ className }: { readonly className?: string }) {
  return (
    <div
      className={cn('rounded-xl bg-surface-1 p-5 shadow-sm space-y-3', className)}
      data-testid="skeleton-card"
      aria-hidden="true"
    >
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-1/3 rounded-full" />
        <Skeleton className="h-4 w-16 rounded-full" />
      </div>
      <Skeleton className="h-3 w-2/3 rounded-full" />
      <div className="pt-2">
        <Skeleton className="h-9 w-full rounded-lg" />
      </div>
    </div>
  );
}

export function SkeletonButton({ className }: { readonly className?: string }) {
  return (
    <Skeleton className={cn('h-[40px] w-32 rounded-md', className)} data-testid="skeleton-button" />
  );
}

export function SkeletonInput({
  className,
  'data-testid': testId = 'skeleton-input',
}: {
  readonly className?: string;
  readonly 'data-testid'?: string;
}) {
  return <Skeleton className={cn('h-[40px] w-full rounded-md', className)} data-testid={testId} />;
}

export function SkeletonBadge({ className }: { readonly className?: string }) {
  return (
    <Skeleton className={cn('h-5 w-16 rounded-full', className)} data-testid="skeleton-badge" />
  );
}

export function SkeletonListItem({ className }: { readonly className?: string }) {
  return (
    <div
      className={cn('flex items-center gap-3.5 p-3 rounded-xl bg-surface-2', className)}
      data-testid="skeleton-list-item"
      aria-hidden="true"
    >
      <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-3 w-48 rounded-full" />
        <Skeleton className="h-2.5 w-32 rounded-full" />
      </div>
    </div>
  );
}

export function SkeletonRow({ className }: { readonly className?: string }) {
  return (
    <div
      className={cn('flex items-center gap-3.5 py-2.5', className)}
      data-testid="skeleton-row"
      aria-hidden="true"
    >
      <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-3.5 w-60 max-w-[80%] rounded-full" />
        <Skeleton className="h-3 w-40 max-w-[55%] rounded-full" />
      </div>
    </div>
  );
}

export function SkeletonTestPlan({ className }: { readonly className?: string }) {
  return (
    <div
      className={cn('rounded-xl bg-surface-2 p-5 shadow-sm space-y-4', className)}
      data-testid="skeleton-test-plan"
      aria-hidden="true"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between pb-3">
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-48 rounded-full" />
          <Skeleton className="h-3 w-64 rounded-full" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-6 w-28 rounded-full" />
          <Skeleton className="h-6 w-32 rounded-full" />
        </div>
      </div>
      <div className="space-y-2.5">
        <div className="rounded-lg bg-surface-1 p-3 space-y-2">
          <Skeleton className="h-4 w-1/3 rounded-full" />
          <Skeleton className="h-3 w-full rounded-full" />
          <Skeleton className="h-3 w-4/5 rounded-full" />
        </div>
        <div className="rounded-lg bg-surface-1 p-3 space-y-2">
          <Skeleton className="h-4 w-1/4 rounded-full" />
          <Skeleton className="h-3 w-full rounded-full" />
          <Skeleton className="h-3 w-3/4 rounded-full" />
        </div>
      </div>
    </div>
  );
}
