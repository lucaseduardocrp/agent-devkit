import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { cn } from '../../lib/utils.js';
import { Skeleton } from '../../components/ui/skeleton.js';

export interface E2eImageProps {
  readonly apiClient: ApiClient;
  /** Path of the image under `/e2e` (see `e2eImagePath`). */
  readonly path: string;
  /** Changing it loads the image again; the previous one stays until the new one arrives. */
  readonly version?: string | number;
  readonly alt: string;
  readonly className?: string;
  /** Shown instead of the broken-image mark while there is no picture to show. */
  readonly fallback?: ReactNode;
}

/**
 * An image the API only serves to signed-in members: downloaded through the client and shown
 * from memory. A live frame keeps showing its last picture while the next one loads or fails.
 */
export function E2eImage({ apiClient, path, version, alt, className, fallback }: E2eImageProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const current = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiClient
      .getE2eImage(path, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        if (current.current) URL.revokeObjectURL(current.current);
        current.current = URL.createObjectURL(blob);
        setUrl(current.current);
        setFailed(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [apiClient, path, version]);

  useEffect(
    () => () => {
      if (current.current) URL.revokeObjectURL(current.current);
    },
    [],
  );

  if (url) return <img src={url} alt={alt} className={className} />;
  if (failed)
    return fallback ? (
      <span className={cn('flex items-center justify-center', className)}>{fallback}</span>
    ) : (
      <span
        role="img"
        aria-label={alt}
        className={cn(
          'flex items-center justify-center bg-[var(--surface-2)] text-[var(--text-muted)]',
          className,
        )}
      >
        <i className="ti ti-photo-off text-xl" aria-hidden="true" />
      </span>
    );
  return <Skeleton className={className} />;
}
