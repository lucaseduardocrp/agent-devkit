import { Skeleton } from './skeleton.js';

const ROW_WIDTHS = ['w-3/4', 'w-1/2', 'w-2/3'] as const;

/**
 * The rows a dropdown shows while its next page loads: placeholders shaped like options, with the
 * loading text kept for screen readers.
 */
export function SelectLoadingRows({
  message,
  rows = 2,
}: {
  readonly message: string;
  readonly rows?: number;
}) {
  return (
    <li role="status" data-testid="select-loading" className="px-3 py-1">
      <span className="sr-only">{message}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center py-2" aria-hidden="true">
          <Skeleton className={`h-3 ${ROW_WIDTHS[index % ROW_WIDTHS.length]}`} />
        </div>
      ))}
    </li>
  );
}
