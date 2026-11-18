import type { ReactNode } from 'react';
import { Skeleton } from '../../components/ui/skeleton.js';

/** A card with the look of `Section` in the tab, so nothing jumps when the content arrives. */
function CardShell({ titleWidth, children }: { titleWidth: string; children: ReactNode }) {
  return (
    <div className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4">
      <Skeleton className={`h-4 rounded-md ${titleWidth}`} />
      {children}
    </div>
  );
}

/** A label above a 40px field, as in the form grids. */
function Field({ label }: { label: string }) {
  return (
    <div className="space-y-1">
      <Skeleton className={`h-3.5 rounded-md ${label}`} />
      <Skeleton className="h-[40px] w-full rounded-md" />
    </div>
  );
}

function ReferenceRowSkeleton() {
  return (
    <div className="space-y-2 rounded-md border border-[var(--border)] p-3">
      <div className="grid gap-2 sm:grid-cols-[150px_minmax(0,1fr)_auto]">
        <Skeleton className="h-[40px] w-full rounded-md" />
        <Skeleton className="h-[40px] w-full rounded-md" />
        <Skeleton className="h-8 w-8 rounded-md" />
      </div>
      <Skeleton className="h-[40px] w-full rounded-md" />
    </div>
  );
}

/** The agent tab while its brief loads: same sections, fields and rhythm as the loaded tab. */
export function AgentBriefSkeleton({ label }: { label: string }) {
  return (
    <div className="space-y-4" role="status" aria-label={label} data-testid="agent-brief-skeleton">
      <Skeleton className="h-4 w-3/4 max-w-[640px] rounded-md" />

      <CardShell titleWidth="w-28">
        <div className="flex items-center gap-2">
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-4 w-24 rounded-md" />
        </div>
        <div className="space-y-1.5 pl-5">
          <Skeleton className="h-3 w-64 max-w-[70%] rounded-md" />
          <Skeleton className="h-3 w-48 max-w-[55%] rounded-md" />
        </div>
      </CardShell>

      <CardShell titleWidth="w-40">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="w-16" />
          <Field label="w-12" />
          <Field label="w-14" />
        </div>
        <Skeleton className="h-3 w-72 max-w-[60%] rounded-md" />
        <Skeleton className="h-4 w-full max-w-[920px] rounded-md" />
        <Skeleton className="h-4 w-56 rounded-md" />
      </CardShell>

      <CardShell titleWidth="w-24">
        <ReferenceRowSkeleton />
        <ReferenceRowSkeleton />
        <Skeleton className="h-10 w-44 rounded-md" />
      </CardShell>

      <CardShell titleWidth="w-20">
        <Skeleton className="h-[40px] w-full rounded-md" />
        <Skeleton className="h-[40px] w-full rounded-md" />
        <Skeleton className="h-10 w-36 rounded-md" />
      </CardShell>

      <CardShell titleWidth="w-36">
        <div className="flex flex-wrap gap-1">
          <Skeleton className="h-8 w-40 rounded-md" />
          <Skeleton className="h-8 w-20 rounded-md" />
          <Skeleton className="h-8 w-44 rounded-md" />
          <Skeleton className="h-8 w-24 rounded-md" />
        </div>
        <Skeleton className="h-3 w-80 max-w-[60%] rounded-md" />
        <Skeleton className="h-28 w-full rounded-md" />
        <Skeleton className="h-3 w-44 rounded-md" />
      </CardShell>

      <CardShell titleWidth="w-32">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="w-28" />
          <Field label="w-28" />
        </div>
      </CardShell>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Skeleton className="h-3 w-64 max-w-[50%] rounded-md" />
        <div className="flex gap-2">
          <Skeleton className="h-10 w-48 rounded-md" />
          <Skeleton className="h-10 w-32 rounded-md" />
          <Skeleton className="h-10 w-40 rounded-md" />
        </div>
      </div>
    </div>
  );
}
