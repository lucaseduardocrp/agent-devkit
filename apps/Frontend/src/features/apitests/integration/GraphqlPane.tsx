import React, { useMemo, useRef, useState } from 'react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { useI18n } from '../../../lib/i18n/index.js';
import type { ApiMockValue, ApiRequestSpec, GraphqlSpec } from '../api-test-types.js';
import { CodeEditor, type CodeEditorHandle } from './CodeEditor.js';
import { CodeEditorToolbar } from './CodeEditorToolbar.js';
import {
  fieldCompletions,
  introspectionRequest,
  parseIntrospection,
  schemaCache,
  type GraphqlSchema,
} from './graphql-schema.js';
import { GraphqlSchemaExplorer } from './GraphqlSchemaExplorer.js';
import type { RequestActions } from './request-actions.js';

type SchemaState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly schema: GraphqlSchema }
  | { readonly status: 'error'; readonly message: string };

const spec = (request: ApiRequestSpec): GraphqlSpec => request.graphql ?? { query: '' };

/** The Query tab of a GraphQL request: the document, its operation, the schema and its docs. */
export function GraphqlQueryTab({
  request,
  readOnly,
  actions,
  mocks,
  mocksFailed,
  onRetryMocks,
  onChange,
}: {
  readonly request: ApiRequestSpec;
  readonly readOnly: boolean;
  readonly actions?: RequestActions;
  readonly mocks: readonly ApiMockValue[] | null;
  readonly mocksFailed: boolean;
  readonly onRetryMocks: () => void;
  readonly onChange: (request: ApiRequestSpec) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const editor = useRef<CodeEditorHandle>(null);
  const cached = schemaCache.get(request.url);
  const [state, setState] = useState<SchemaState>(
    cached ? { status: 'ready', schema: cached } : { status: 'idle' },
  );
  const [docs, setDocs] = useState(false);
  const graphql = spec(request);
  const set = (patch: Partial<GraphqlSpec>) =>
    onChange({ ...request, graphql: { ...graphql, ...patch } });
  // The schema of another URL (the URL was edited) does not apply.
  const schema =
    state.status === 'ready' && schemaCache.get(request.url) === state.schema ? state.schema : null;
  const completions = useMemo(() => (schema ? fieldCompletions(schema) : undefined), [schema]);

  const fetchSchema = () => {
    if (!actions) return;
    setState({ status: 'loading' });
    const url = request.url;
    actions
      .runAdHoc(introspectionRequest(request))
      .then((result) => {
        const next = parseIntrospection(result);
        schemaCache.set(url, next);
        setState({ status: 'ready', schema: next });
        setDocs(true);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setState({
          status: 'error',
          message: message === 'truncated' ? t('apiTests.protocol.schemaTruncated') : message,
        });
      });
  };

  return (
    <div className="flex h-full min-h-0 gap-0">
      <div className="flex min-w-0 flex-1 flex-col gap-2 pr-2">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            inputSize="sm"
            className="w-48 font-mono"
            aria-label={t('apiTests.protocol.operationName')}
            placeholder={t('apiTests.protocol.operationName')}
            value={graphql.operationName ?? ''}
            disabled={readOnly}
            onChange={(event) => set({ operationName: event.target.value || undefined })}
          />
          <CodeEditorToolbar
            editor={editor}
            language="graphql"
            readOnly={readOnly}
            mocks={mocks}
            mocksFailed={mocksFailed}
            onRetryMocks={onRetryMocks}
          />
          <span className="flex-1" />
          {actions && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={state.status === 'loading'}
              aria-pressed={schema ? docs : undefined}
              data-testid="graphql-schema"
              onClick={() => (schema ? setDocs(!docs) : fetchSchema())}
            >
              <i
                className={
                  state.status === 'loading' ? 'ti ti-loader-2 animate-spin' : 'ti ti-book-2'
                }
                aria-hidden="true"
              />
              {state.status === 'loading'
                ? t('apiTests.protocol.loadingSchema')
                : t('apiTests.protocol.schema')}
            </Button>
          )}
        </div>
        {state.status === 'error' && (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-md border border-[var(--bg-danger)] bg-[var(--bg-danger)] px-3 py-2 text-xs text-[var(--text-danger)]"
          >
            <span className="min-w-0 flex-1">
              {t('apiTests.protocol.schemaFailed', { error: state.message })}
            </span>
            <Button type="button" variant="secondary" size="sm" onClick={fetchSchema}>
              {t('common.retry')}
            </Button>
          </div>
        )}
        <CodeEditor
          ref={editor}
          label={t('apiTests.protocol.query')}
          language="graphql"
          value={graphql.query}
          readOnly={readOnly}
          mocks={mocks}
          completions={completions}
          placeholder={'query {\n  users {\n    id\n  }\n}'}
          onChange={(query) => set({ query })}
          data-testid="graphql-query"
        />
      </div>
      {schema && docs && (
        <GraphqlSchemaExplorer
          schema={schema}
          onClose={() => setDocs(false)}
          onRefresh={fetchSchema}
        />
      )}
    </div>
  );
}

/** The Variables tab of a GraphQL request: JSON. */
export function GraphqlVariablesTab({
  request,
  readOnly,
  mocks,
  mocksFailed,
  onRetryMocks,
  onChange,
}: {
  readonly request: ApiRequestSpec;
  readonly readOnly: boolean;
  readonly mocks: readonly ApiMockValue[] | null;
  readonly mocksFailed: boolean;
  readonly onRetryMocks: () => void;
  readonly onChange: (request: ApiRequestSpec) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const editor = useRef<CodeEditorHandle>(null);
  const graphql = spec(request);
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center gap-2">
        <CodeEditorToolbar
          editor={editor}
          language="json"
          readOnly={readOnly}
          mocks={mocks}
          mocksFailed={mocksFailed}
          onRetryMocks={onRetryMocks}
        />
      </div>
      <CodeEditor
        ref={editor}
        label={t('apiTests.protocol.variables')}
        language="json"
        value={graphql.variables ?? ''}
        readOnly={readOnly}
        mocks={mocks}
        placeholder={'{\n  "id": "{{userId}}"\n}'}
        onChange={(variables) => onChange({ ...request, graphql: { ...graphql, variables } })}
      />
    </div>
  );
}
