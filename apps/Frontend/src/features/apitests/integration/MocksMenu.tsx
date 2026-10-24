import React, { useMemo, useState } from 'react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Skeleton } from '../../../components/ui/skeleton.js';
import { useI18n } from '../../../lib/i18n/index.js';
import { cn } from '../../../lib/utils.js';
import { MOCK_GROUPS, type ApiMockValue } from '../api-test-types.js';
import type { CodeLanguage } from './code-syntax.js';
import { MOCK_TEMPLATES, type MockTemplate } from './mock-templates.js';

type Tab = 'values' | 'templates';

/**
 * The content of the Mocks popover: the generated values requests can use (`{{$randomFullName}}`,
 * `{{$randomCPF}}`...), grouped and searchable, each with a sample, and ready-made JSON bodies.
 */
export function MocksMenu({
  mocks,
  failed,
  language,
  onPickValue,
  onPickTemplate,
  onRetry,
}: {
  /** null while the list loads. */
  readonly mocks: readonly ApiMockValue[] | null;
  readonly failed: boolean;
  /** Loads the list again, after it failed. */
  readonly onRetry: () => void;
  readonly language: CodeLanguage;
  readonly onPickValue: (name: string) => void;
  readonly onPickTemplate: (template: MockTemplate) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('values');
  const [query, setQuery] = useState('');
  const templates = language === 'json';
  const current: Tab = templates ? tab : 'values';

  const groups = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return MOCK_GROUPS.map((group) => {
      const label = t(`apiTests.mocks.groups.${group}`);
      return {
        group,
        label,
        items: (mocks ?? []).filter(
          (mock) =>
            mock.group === group &&
            terms.every((term) =>
              `${mock.name} ${mock.sample} ${label}`.toLowerCase().includes(term),
            ),
        ),
      };
    }).filter((entry) => entry.items.length > 0);
  }, [mocks, query, t]);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="shrink-0 border-b border-border p-3">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">
          {t('apiTests.mocks.title')}
        </h3>
        <p className="mt-0.5 text-xs text-[var(--text-muted)]">{t('apiTests.mocks.hint')}</p>
        {templates && (
          <div className="mt-2 flex gap-1" role="tablist" aria-label={t('apiTests.mocks.title')}>
            {(['values', 'templates'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={current === value}
                onClick={() => setTab(value)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium',
                  current === value
                    ? 'bg-[var(--fill-ghost-selected)] text-[var(--text-primary)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]',
                )}
              >
                {t(value === 'values' ? 'apiTests.mocks.tabValues' : 'apiTests.mocks.tabTemplates')}
              </button>
            ))}
          </div>
        )}
        {current === 'values' && (
          // The margin goes on a wrapper: on the Input it would grow the box the icon is centered in.
          <div className="mt-2">
            <Input
              leftIcon={<i className="ti ti-search" aria-hidden="true" />}
              value={query}
              placeholder={t('apiTests.mocks.search')}
              aria-label={t('apiTests.mocks.search')}
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1" role="tabpanel">
        {current === 'templates' &&
          MOCK_TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-[var(--fill-ghost-hover)]"
              data-testid={`mock-template-${template.id}`}
              onClick={() => onPickTemplate(template)}
            >
              <span className="text-xs font-medium text-[var(--text-primary)]">
                {t(`apiTests.mocks.templates.${template.id}.name`)}
              </span>
              <span className="text-[11px] text-[var(--text-muted)]">
                {t(`apiTests.mocks.templates.${template.id}.description`)}
              </span>
            </button>
          ))}

        {current === 'values' && mocks === null && !failed && (
          <div className="flex flex-col gap-2 px-3 py-2" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((row) => (
              <Skeleton key={row} className="h-5 w-full rounded-md" />
            ))}
          </div>
        )}
        {current === 'values' && failed && (
          <div className="flex flex-col items-start gap-2 px-3 py-3">
            <p className="text-xs text-[var(--text-muted)]">{t('apiTests.mocks.unavailable')}</p>
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              <i className="ti ti-refresh" aria-hidden="true" />
              {t('common.retry')}
            </Button>
          </div>
        )}
        {current === 'values' && mocks !== null && groups.length === 0 && (
          <p className="px-3 py-3 text-xs text-[var(--text-muted)]">{t('apiTests.mocks.empty')}</p>
        )}
        {current === 'values' &&
          groups.map(({ group, label, items }) => (
            <section key={group} aria-label={label}>
              <h4 className="sticky top-0 bg-surface-1 px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                {label}
              </h4>
              {items.map((mock) => (
                <button
                  key={mock.name}
                  type="button"
                  aria-label={t('apiTests.mocks.insert', { name: mock.name })}
                  className="flex w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-[var(--fill-ghost-hover)]"
                  data-testid={`mock-${mock.name}`}
                  onClick={() => onPickValue(mock.name)}
                >
                  <span className="shrink-0 font-mono text-xs text-[var(--text-pro)]">
                    {mock.name}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-[var(--text-muted)]">
                    {mock.sample}
                  </span>
                </button>
              ))}
            </section>
          ))}
      </div>
    </div>
  );
}
