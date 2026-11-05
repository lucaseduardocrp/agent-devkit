import React, { useMemo, useState } from 'react';
import { Button } from '../../../components/ui/button.js';
import { IconButton } from '../../../components/ui/icon-button.js';
import { Input } from '../../../components/ui/input.js';
import { useI18n } from '../../../lib/i18n/index.js';
import {
  namedType,
  typeLabel,
  type GraphqlSchema,
  type SchemaInputValue,
  type TypeRef,
} from './graphql-schema.js';

function TypeLink({
  type,
  onOpen,
}: {
  readonly type: TypeRef;
  readonly onOpen: (name: string) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="font-mono text-[var(--code-tag)] hover:underline"
      onClick={() => onOpen(namedType(type))}
    >
      {typeLabel(type)}
    </button>
  );
}

function Description({ text }: { readonly text?: string | null }): React.JSX.Element | null {
  return text ? <p className="text-[11px] text-[var(--text-muted)]">{text}</p> : null;
}

function Args({
  args,
  onOpen,
}: {
  readonly args: readonly SchemaInputValue[];
  readonly onOpen: (name: string) => void;
}): React.JSX.Element | null {
  if (!args.length) return null;
  return (
    <>
      (
      {args.map((arg, index) => (
        <span key={arg.name}>
          {index > 0 && ', '}
          <span className="text-[var(--code-attr)]">{arg.name}</span>:{' '}
          <TypeLink type={arg.type} onOpen={onOpen} />
        </span>
      ))}
      )
    </>
  );
}

/**
 * The docs of a GraphQL schema, as GraphiQL shows them: the root types, every type with its
 * fields, arguments and descriptions, a search, and links from each type to its own page.
 */
export function GraphqlSchemaExplorer({
  schema,
  onClose,
  onRefresh,
}: {
  readonly schema: GraphqlSchema;
  readonly onClose: () => void;
  readonly onRefresh: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [history, setHistory] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const current = history.length ? schema.types.get(history[history.length - 1]!) : null;
  const open = (name: string) => {
    setQuery('');
    setHistory((stack) => [...stack, name]);
  };

  const matches = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return [];
    const found: { type: string; field?: string }[] = [];
    for (const type of schema.types.values()) {
      if (type.name.toLowerCase().includes(text)) found.push({ type: type.name });
      for (const field of type.fields ?? [])
        if (field.name.toLowerCase().includes(text))
          found.push({ type: type.name, field: field.name });
    }
    return found.slice(0, 100);
  }, [query, schema]);

  const roots = [
    ['Query', schema.queryType],
    ['Mutation', schema.mutationType],
    ['Subscription', schema.subscriptionType],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

  return (
    <aside
      className="flex w-80 shrink-0 flex-col border-l border-[var(--border)] bg-[var(--surface-1)]"
      aria-label={t('apiTests.protocol.schemaDocs')}
      data-testid="graphql-docs"
    >
      <div className="flex items-center gap-1 border-b border-[var(--border)] p-2">
        {history.length > 0 && (
          <IconButton
            variant="ghost"
            icon={<i className="ti ti-arrow-left text-sm" aria-hidden="true" />}
            label={t('apiTests.protocol.back')}
            onClick={() => setHistory((stack) => stack.slice(0, -1))}
          />
        )}
        <h3 className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--text-primary)]">
          {current?.name ?? t('apiTests.protocol.schemaDocs')}
        </h3>
        <IconButton
          variant="ghost"
          icon={<i className="ti ti-refresh text-sm" aria-hidden="true" />}
          label={t('apiTests.protocol.reloadSchema')}
          onClick={onRefresh}
        />
        <IconButton
          variant="ghost"
          icon={<i className="ti ti-x text-sm" aria-hidden="true" />}
          label={t('apiTests.close')}
          onClick={onClose}
        />
      </div>
      <div className="border-b border-[var(--border)] p-2">
        <Input
          inputSize="sm"
          aria-label={t('apiTests.protocol.searchSchema')}
          placeholder={t('apiTests.protocol.searchSchema')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2 text-xs">
        {query.trim() ? (
          matches.length ? (
            <ul className="flex flex-col" data-testid="schema-search-results">
              {matches.map((match) => (
                <li key={`${match.type}.${match.field ?? ''}`}>
                  <button
                    type="button"
                    className="w-full rounded px-1.5 py-1 text-left font-mono hover:bg-[var(--fill-ghost-hover)]"
                    onClick={() => open(match.type)}
                  >
                    <span className="text-[var(--code-tag)]">{match.type}</span>
                    {match.field && (
                      <span className="text-[var(--text-primary)]">.{match.field}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[var(--text-muted)]">{t('apiTests.ui.noMatches')}</p>
          )
        ) : current ? (
          <div className="flex flex-col gap-3">
            <p className="font-mono text-[10px] uppercase text-[var(--text-muted)]">
              {current.kind}
            </p>
            <Description text={current.description} />
            {current.fields?.length ? (
              <ul className="flex flex-col gap-2">
                {current.fields.map((field) => (
                  <li key={field.name} className="font-mono">
                    <span className="text-[var(--code-key)]">{field.name}</span>
                    <Args args={field.args} onOpen={open} />:{' '}
                    <TypeLink type={field.type} onOpen={open} />
                    {field.isDeprecated && (
                      <span className="ml-1 text-[10px] text-[var(--text-warning)]">
                        {t('apiTests.protocol.deprecated')}
                      </span>
                    )}
                    <Description text={field.description} />
                  </li>
                ))}
              </ul>
            ) : null}
            {current.inputFields?.length ? (
              <ul className="flex flex-col gap-2">
                {current.inputFields.map((field) => (
                  <li key={field.name} className="font-mono">
                    <span className="text-[var(--code-attr)]">{field.name}</span>:{' '}
                    <TypeLink type={field.type} onOpen={open} />
                    <Description text={field.description} />
                  </li>
                ))}
              </ul>
            ) : null}
            {current.enumValues?.length ? (
              <ul className="flex flex-col gap-1">
                {current.enumValues.map((value) => (
                  <li key={value.name} className="font-mono text-[var(--code-number)]">
                    {value.name}
                    <Description text={value.description} />
                  </li>
                ))}
              </ul>
            ) : null}
            {current.possibleTypes?.length ? (
              <div className="flex flex-wrap gap-2">
                {current.possibleTypes.map((type) => (
                  <TypeLink key={namedType(type)} type={type} onOpen={open} />
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <ul className="flex flex-col gap-1">
              {roots.map(([label, name]) => (
                <li key={label}>
                  <span className="text-[var(--text-muted)]">{label}: </span>
                  <button
                    type="button"
                    className="font-mono text-[var(--code-tag)] hover:underline"
                    onClick={() => open(name)}
                  >
                    {name}
                  </button>
                </li>
              ))}
            </ul>
            <h4 className="font-semibold text-[var(--text-secondary)]">
              {t('apiTests.protocol.allTypes')}
            </h4>
            <ul className="flex flex-col gap-0.5">
              {[...schema.types.keys()].sort().map((name) => (
                <li key={name}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 w-full justify-start px-1.5 font-mono font-normal"
                    onClick={() => open(name)}
                  >
                    {name}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </aside>
  );
}
