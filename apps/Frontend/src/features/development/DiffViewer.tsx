import { useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../lib/i18n/index.js';
import type { DiffFile } from './development-types.js';

const STATUS_ICONS: Record<DiffFile['status'], string> = {
  added: 'ti-file-plus',
  modified: 'ti-file-pencil',
  deleted: 'ti-file-minus',
  renamed: 'ti-file-arrow-right',
};

function lineClass(line: string): string {
  if (line.startsWith('@@')) return 'text-[var(--text-accent)]';
  if (line.startsWith('+')) return 'bg-green-500/10 text-green-300';
  return line.startsWith('-') ? 'bg-red-500/10 text-red-300' : '';
}

/** The files a session changed and the unified diff of the one being read. */
export function DiffViewer({ files }: { readonly files: readonly DiffFile[] }) {
  const { t, messages } = useI18n();
  const [path, setPath] = useState<string | null>(null);
  const file = files.find((item) => item.path === path) ?? files[0];
  if (!file)
    return <p className="text-sm text-[var(--text-muted)]">{messages.development.noDiff}</p>;
  return (
    <div className="grid gap-3 lg:grid-cols-[260px_minmax(0,1fr)]">
      <ul className="space-y-1" aria-label={messages.development.files}>
        {files.map((item) => (
          <li key={item.path}>
            <Button
              variant={item.path === file.path ? 'secondary' : 'ghost'}
              size="sm"
              aria-pressed={item.path === file.path}
              className="flex h-auto w-full justify-start gap-2 py-1.5 text-left"
              onClick={() => setPath(item.path)}
            >
              <i className={cn('ti shrink-0', STATUS_ICONS[item.status])} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{item.path}</span>
              <span className="shrink-0 font-mono text-xs">
                <span className="text-green-400">+{item.additions}</span>{' '}
                <span className="text-red-400">-{item.deletions}</span>
              </span>
            </Button>
          </li>
        ))}
      </ul>
      <pre
        className="max-h-[60vh] overflow-auto rounded-md border border-[var(--border)] bg-[var(--surface-0)] p-3 font-mono text-xs"
        aria-label={t('development.diffOf', { path: file.path })}
      >
        {file.patch.split('\n').map((line, index) => (
          <span key={index} className={cn('block whitespace-pre', lineClass(line))}>
            {line || ' '}
          </span>
        ))}
      </pre>
    </div>
  );
}
