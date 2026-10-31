import React, { useId, useState } from 'react';
import { Button } from '../../../components/ui/button.js';
import { IconButton } from '../../../components/ui/icon-button.js';
import { Input } from '../../../components/ui/input.js';
import { Modal } from '../../../components/ui/modal.js';
import { SearchableSelect } from '../../../components/ui/searchable-select.js';
import { Select } from '../../../components/ui/select.js';
import { useI18n } from '../../../lib/i18n/index.js';
import { cn } from '../../../lib/utils.js';
import { RenderedCode } from '../../brain/RenderedCode.js';
import {
  ASSERTION_OPERATORS,
  ASSERTION_SOURCES,
  HTTP_METHODS,
  type ApiCollection,
  type ApiMockValue,
  type ApiRequestSpec,
  type Assertion,
  type Capture,
  type HttpMethod,
  type RequestKind,
} from '../api-test-types.js';
import { KeyValueEditor } from '../ApiTestShared.js';
import { VariableInput } from '../VariableInput.js';
import { AuthEditor } from './AuthEditor.js';
import { BodyEditor } from './BodyEditor.js';
import { CODE_TARGET_INFO, codeTargets, generateCode, type CodeTarget } from './code-generation.js';
import { DocsEditor } from './DocsEditor.js';
import { GraphqlQueryTab, GraphqlVariablesTab } from './GraphqlPane.js';
import { GrpcMessageTab, GrpcMethodPicker } from './GrpcPane.js';
import { inheritedAuth } from './inheritance.js';
import {
  KIND_COLOR,
  KIND_SHORT,
  METHOD_COLOR,
  composeUrl,
  sameUrl,
  splitUrl,
  syncPathParams,
} from './integration-model.js';
import { PaneTabs, type PaneTab } from './integration-parts.js';
import { MessagesEditor } from './MessagesEditor.js';
import type { RequestActions } from './request-actions.js';
import { RequestSettingsEditor } from './RequestSettingsEditor.js';
import { ScriptEditor } from './ScriptEditor.js';

const kindOf = (request: Pick<ApiRequestSpec, 'kind'>): RequestKind => request.kind ?? 'http';

/** The methods each kind may use; none for the kinds that have no HTTP method. */
const KIND_METHODS: Partial<Record<RequestKind, readonly HttpMethod[]>> = {
  http: HTTP_METHODS,
  graphql: ['POST', 'GET'],
  sse: HTTP_METHODS,
};

const URL_PLACEHOLDERS: Record<RequestKind, string> = {
  http: '{{baseUrl}}/users/:id',
  graphql: '{{baseUrl}}/graphql',
  grpc: 'grpc://localhost:50051',
  websocket: 'wss://example.com/socket',
  sse: '{{baseUrl}}/events',
  socket: 'tcp://localhost:9000',
};

// ---------- URL bar ----------

export function UrlBar({
  request,
  collection,
  readOnly,
  dirty,
  sending,
  actions,
  onChange,
  onSend,
  onCancel,
  onSave,
}: {
  readonly request: ApiRequestSpec;
  readonly collection: ApiCollection;
  readonly readOnly: boolean;
  readonly dirty: boolean;
  readonly sending: boolean;
  /** Lists the gRPC methods of the server (the gRPC method picker). */
  readonly actions?: RequestActions;
  readonly onChange: (request: ApiRequestSpec) => void;
  readonly onSend: () => void;
  readonly onCancel: () => void;
  readonly onSave: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const kind = kindOf(request);
  const methods = KIND_METHODS[kind];
  const [showCode, setShowCode] = useState(false);
  // The bar shows the path with the query. While typing, the text stays as typed (`?a` is not
  // rewritten to `?a=`) as long as it means the same request.
  const [draft, setDraft] = useState<string | null>(null);
  const shown =
    draft !== null && sameUrl(draft, request.url, request.query)
      ? draft
      : composeUrl(request.url, request.query);
  // The Params tab follows the `:name` segments, the Query tab the `?a=b` pairs.
  const changeUrl = (text: string) => {
    setDraft(text);
    const { url, query } = splitUrl(text, request.query);
    onChange({ ...request, url, query, pathParams: syncPathParams(url, request.pathParams) });
  };
  return (
    <div className="flex shrink-0 items-start gap-2 px-3 py-2.5" data-testid="request-editor">
      <div className="flex min-w-0 flex-1 items-center">
        {methods ? (
          <div className="w-[124px] shrink-0">
            <SearchableSelect
              label={t('apiTests.method')}
              placeholder={t('apiTests.method')}
              emptyMessage={t('apiTests.ui.noMatches')}
              className="rounded-r-none font-mono font-bold"
              value={request.method}
              disabled={readOnly}
              options={methods.map((method) => ({
                value: method,
                label: method,
                className: cn('font-mono font-bold', METHOD_COLOR[method]),
              }))}
              onChange={(method) =>
                method && onChange({ ...request, method: method as ApiRequestSpec['method'] })
              }
              searchable={false}
              data-testid="method-select"
            />
          </div>
        ) : (
          <span
            className={cn(
              'flex h-[40px] w-[72px] shrink-0 items-center justify-center rounded-l-md border border-r-0 border-border bg-surface-2 font-mono text-xs font-bold',
              KIND_COLOR[kind as Exclude<RequestKind, 'http'>],
            )}
            data-testid="kind-label"
          >
            {KIND_SHORT[kind as Exclude<RequestKind, 'http'>]}
          </span>
        )}
        <VariableInput
          mono
          aria-label="URL"
          containerClassName="-ml-px"
          className="rounded-l-none"
          value={shown}
          disabled={readOnly}
          placeholder={URL_PLACEHOLDERS[kind]}
          onValueChange={changeUrl}
          onBlur={() => setDraft(null)}
        />
      </div>
      {kind === 'grpc' && (
        <GrpcMethodPicker
          request={request}
          readOnly={readOnly}
          actions={actions}
          onChange={onChange}
        />
      )}
      <IconButton
        variant="subtle"
        icon={<i className="ti ti-code" aria-hidden="true" />}
        label={t('apiTests.ui.generateCode')}
        title={t('apiTests.ui.generateCode')}
        onClick={() => setShowCode(true)}
        data-testid="generate-code"
      />
      {!readOnly && (
        <IconButton
          variant="default"
          icon={<i className="ti ti-device-floppy" aria-hidden="true" />}
          label={t('apiTests.save')}
          title={`${t('apiTests.save')} (Ctrl + S)`}
          disabled={!dirty}
          onClick={onSave}
          data-testid="save-collection"
        />
      )}
      {!readOnly &&
        (sending ? (
          <Button variant="secondary" onClick={onCancel} data-testid="cancel-request">
            <i className="ti ti-player-stop" aria-hidden="true" />
            {t('apiTests.ui.cancelRequest')}
          </Button>
        ) : (
          <Button onClick={onSend} title="Ctrl + Enter" data-testid="run-request">
            <i
              className={cn(
                'ti',
                kind === 'websocket' || kind === 'socket' ? 'ti-plug' : 'ti-send',
              )}
              aria-hidden="true"
            />
            {kind === 'websocket' || kind === 'socket'
              ? t('apiTests.protocol.connect')
              : t('apiTests.send')}
          </Button>
        ))}
      {showCode && (
        <CodeDialog request={request} collection={collection} onClose={() => setShowCode(false)} />
      )}
    </div>
  );
}

function CodeDialog({
  request,
  collection,
  onClose,
}: {
  readonly request: ApiRequestSpec;
  readonly collection: ApiCollection;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const id = useId();
  const targets = codeTargets(request);
  const [target, setTarget] = useState<CodeTarget>(targets[0]!);
  const [copied, setCopied] = useState(false);
  const code = generateCode(target, request, {
    auth: inheritedAuth(collection, request.id).auth,
  });
  const copy = () =>
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  return (
    <Modal open onClose={onClose} labelledBy={id}>
      <div
        className="flex max-h-[calc(100vh-2rem)] w-[min(94vw,760px)] flex-col gap-4 rounded-lg border border-border bg-surface-1 p-6 shadow-2xl"
        data-testid="code-dialog"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 id={id} className="text-lg font-semibold text-[var(--text-primary)]">
            {t('apiTests.ui.generateCode')}
          </h2>
          <IconButton
            icon={<i className="ti ti-x" aria-hidden="true" />}
            label={t('apiTests.close')}
            onClick={onClose}
          />
        </div>
        <Select
          aria-label={t('apiTests.protocol.codeLanguage')}
          containerClassName="w-72"
          value={target}
          disabled={targets.length === 1}
          onChange={(event) => setTarget(event.target.value as CodeTarget)}
          data-testid="code-language"
        >
          {targets.map((value) => (
            <option key={value} value={value}>
              {CODE_TARGET_INFO[value].label}
            </option>
          ))}
        </Select>
        <div className="min-h-0 overflow-auto rounded-md border border-[var(--border)] bg-[var(--surface-0)]">
          <RenderedCode code={code} language={CODE_TARGET_INFO[target].highlight} />
        </div>
        <p className="text-xs text-[var(--text-muted)]">{t('apiTests.ui.generateCodeHint')}</p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('apiTests.close')}
          </Button>
          <Button onClick={copy}>
            <i className={cn('ti', copied ? 'ti-check' : 'ti-copy')} aria-hidden="true" />
            {copied ? t('common.copied') : t('common.copy')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------- editors ----------

function AssertionsEditor({
  assertions,
  readOnly,
  onChange,
}: {
  readonly assertions: readonly Assertion[];
  readonly readOnly: boolean;
  readonly onChange: (assertions: Assertion[]) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const update = (index: number, patch: Partial<Assertion>) =>
    onChange(
      assertions.map((item, position) => (position === index ? { ...item, ...patch } : item)),
    );
  return (
    <div className="flex flex-col gap-2">
      {assertions.map((assertion, index) => {
        const needsPath = assertion.source === 'json' || assertion.source === 'header';
        const needsValue = assertion.operator !== 'exists' && assertion.operator !== 'notExists';
        return (
          <div
            key={assertion.id}
            className="grid grid-cols-[150px_minmax(0,1fr)_170px_minmax(0,1fr)_40px] items-center gap-2"
          >
            <Select
              aria-label={t('apiTests.assertionSource')}
              value={assertion.source}
              disabled={readOnly}
              onChange={(event) =>
                update(index, { source: event.target.value as Assertion['source'] })
              }
            >
              {ASSERTION_SOURCES.map((source) => (
                <option key={source} value={source}>
                  {t(`apiTests.assertionSources.${source}`)}
                </option>
              ))}
            </Select>
            <Input
              className="font-mono"
              aria-label={t('apiTests.ui.path')}
              value={assertion.path ?? ''}
              disabled={readOnly || !needsPath}
              placeholder={
                needsPath
                  ? assertion.source === 'json'
                    ? 'data.items[0].id'
                    : 'content-type'
                  : '—'
              }
              onChange={(event) => update(index, { path: event.target.value })}
            />
            <Select
              aria-label={t('apiTests.operator')}
              value={assertion.operator}
              disabled={readOnly}
              onChange={(event) =>
                update(index, { operator: event.target.value as Assertion['operator'] })
              }
            >
              {ASSERTION_OPERATORS.map((operator) => (
                <option key={operator} value={operator}>
                  {t(`apiTests.operators.${operator}`)}
                </option>
              ))}
            </Select>
            <VariableInput
              mono
              aria-label={t('apiTests.expected')}
              value={assertion.expected ?? ''}
              disabled={readOnly || !needsValue}
              placeholder={needsValue ? t('apiTests.expected') : '—'}
              onValueChange={(expected) => update(index, { expected })}
            />
            {readOnly ? (
              <span />
            ) : (
              <IconButton
                icon={
                  <i className="ti ti-trash text-sm text-[var(--text-danger)]" aria-hidden="true" />
                }
                label={t('apiTests.remove')}
                onClick={() => onChange(assertions.filter((_, position) => position !== index))}
              />
            )}
          </div>
        );
      })}
      {!readOnly && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() =>
            onChange([
              ...assertions,
              { id: crypto.randomUUID(), source: 'status', operator: 'eq', expected: '200' },
            ])
          }
        >
          <i className="ti ti-plus" aria-hidden="true" />
          {t('apiTests.addAssertion')}
        </Button>
      )}
    </div>
  );
}

function CapturesEditor({
  captures,
  readOnly,
  onChange,
}: {
  readonly captures: readonly Capture[];
  readonly readOnly: boolean;
  readonly onChange: (captures: Capture[]) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const update = (index: number, patch: Partial<Capture>) =>
    onChange(captures.map((item, position) => (position === index ? { ...item, ...patch } : item)));
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-[var(--text-muted)]">{t('apiTests.capturesHint')}</p>
      {captures.map((capture, index) => (
        <div
          key={index}
          className="grid grid-cols-[minmax(0,1fr)_150px_minmax(0,1fr)_40px] items-center gap-2"
        >
          <Input
            className="font-mono"
            aria-label={t('apiTests.ui.variable')}
            value={capture.variable}
            disabled={readOnly}
            placeholder="token"
            onChange={(event) => update(index, { variable: event.target.value })}
          />
          <Select
            aria-label={t('apiTests.assertionSource')}
            value={capture.source}
            disabled={readOnly}
            onChange={(event) => update(index, { source: event.target.value as Capture['source'] })}
          >
            <option value="json">JSON</option>
            <option value="header">Header</option>
            <option value="status">Status</option>
            <option value="body">Body</option>
          </Select>
          <Input
            className="font-mono"
            aria-label={t('apiTests.ui.path')}
            value={capture.path ?? ''}
            disabled={readOnly || capture.source === 'status' || capture.source === 'body'}
            placeholder="data.token"
            onChange={(event) => update(index, { path: event.target.value })}
          />
          {readOnly ? (
            <span />
          ) : (
            <IconButton
              icon={
                <i className="ti ti-trash text-sm text-[var(--text-danger)]" aria-hidden="true" />
              }
              label={t('apiTests.remove')}
              onClick={() => onChange(captures.filter((_, position) => position !== index))}
            />
          )}
        </div>
      ))}
      {!readOnly && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => onChange([...captures, { variable: '', source: 'json', path: '' }])}
        >
          <i className="ti ti-plus" aria-hidden="true" />
          {t('apiTests.addCapture')}
        </Button>
      )}
    </div>
  );
}

// ---------- request pane ----------

type RequestTab =
  | 'query'
  | 'body'
  | 'gqlQuery'
  | 'gqlVariables'
  | 'message'
  | 'messages'
  | 'headers'
  | 'auth'
  | 'vars'
  | 'script'
  | 'assertions'
  | 'captures'
  | 'tests'
  | 'docs'
  | 'settings';

/** The tabs of each kind, in order, as in Bruno. */
const KIND_TABS: Record<RequestKind, readonly RequestTab[]> = {
  http: [
    'query',
    'body',
    'headers',
    'auth',
    'vars',
    'script',
    'assertions',
    'captures',
    'tests',
    'docs',
    'settings',
  ],
  graphql: [
    'gqlQuery',
    'gqlVariables',
    'headers',
    'auth',
    'vars',
    'script',
    'assertions',
    'captures',
    'tests',
    'docs',
    'settings',
  ],
  grpc: [
    'message',
    'headers',
    'auth',
    'vars',
    'script',
    'assertions',
    'captures',
    'tests',
    'docs',
    'settings',
  ],
  websocket: [
    'messages',
    'headers',
    'auth',
    'vars',
    'settings',
    'script',
    'assertions',
    'captures',
    'tests',
    'docs',
  ],
  sse: [
    'headers',
    'auth',
    'body',
    'vars',
    'settings',
    'script',
    'assertions',
    'captures',
    'tests',
    'docs',
  ],
  socket: ['messages', 'vars', 'settings', 'script', 'assertions', 'captures', 'tests', 'docs'],
};

const firstTab = (request: ApiRequestSpec): RequestTab => {
  const kind = kindOf(request);
  if (kind === 'http') return request.body.mode !== 'none' ? 'body' : 'query';
  return KIND_TABS[kind][0]!;
};

export function RequestPane({
  request,
  collection,
  actions,
  readOnly,
  onChange,
  mocks = null,
  mocksFailed = false,
  onRetryMocks = () => undefined,
  onClearPersonal,
}: {
  readonly request: ApiRequestSpec;
  /** Proto files, auth inheritance and personal secrets of the collection the request is in. */
  readonly collection?: ApiCollection;
  /** Runs the GraphQL introspection (schema docs and completion). */
  readonly actions?: RequestActions;
  readonly readOnly: boolean;
  readonly onChange: (request: ApiRequestSpec) => void;
  /** The mock values the API offers, for the body editor; null while they load. */
  readonly mocks?: readonly ApiMockValue[] | null;
  readonly mocksFailed?: boolean;
  readonly onRetryMocks?: () => void;
  /** Forgets one of the current user's personal secrets (the Auth tab). */
  readonly onClearPersonal?: (ref: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const kind = kindOf(request);
  const [chosen, setChosen] = useState<RequestTab>(() => firstTab(request));
  // A kind change (rare) keeps a tab that exists.
  const tab = KIND_TABS[kind].includes(chosen) ? chosen : firstTab(request);
  const set = (patch: Partial<ApiRequestSpec>) => onChange({ ...request, ...patch });
  const pathParams = syncPathParams(request.url, request.pathParams);
  const enabled = (rows: readonly { enabled?: boolean }[] = []) =>
    rows.filter((row) => row.enabled !== false).length;
  const mark = (value: unknown) => (value ? '•' : '');
  const editorProps = { readOnly, mocks, mocksFailed, onRetryMocks, onChange };
  const websocket = request.websocket ?? { messages: [] };
  const socket = request.socket ?? { messages: [] };

  const tabInfo: Record<RequestTab, Omit<PaneTab<RequestTab>, 'id'>> = {
    query: { label: t('apiTests.ui.query'), indicator: enabled(request.query) + pathParams.length },
    body: { label: t('apiTests.tabs.body'), indicator: mark(request.body.mode !== 'none') },
    gqlQuery: {
      label: t('apiTests.protocol.query'),
      indicator: mark(request.graphql?.query.trim()),
    },
    gqlVariables: {
      label: t('apiTests.protocol.variables'),
      indicator: mark((request.graphql?.variables ?? '').replace(/[\s{}]/g, '')),
    },
    message: { label: t('apiTests.protocol.message') },
    messages: {
      label: t('apiTests.protocol.messages'),
      indicator: (kind === 'socket' ? socket : websocket).messages.length,
    },
    headers: {
      label: kind === 'grpc' ? t('apiTests.protocol.metadata') : t('apiTests.tabs.headers'),
      indicator: enabled(request.headers),
    },
    auth: {
      label: t('apiTests.tabs.auth'),
      indicator: mark(request.auth.type !== 'inherit' && request.auth.type !== 'none'),
    },
    vars: { label: t('apiTests.protocol.vars'), indicator: enabled(request.vars) },
    script: {
      label: t('apiTests.protocol.script'),
      indicator: mark(request.scripts?.preRequest?.trim() || request.scripts?.postResponse?.trim()),
    },
    assertions: { label: t('apiTests.tabs.assertions'), indicator: request.assertions.length },
    captures: { label: t('apiTests.tabs.captures'), indicator: request.captures.length },
    tests: { label: t('apiTests.protocol.tests'), indicator: mark(request.scripts?.tests?.trim()) },
    docs: { label: t('apiTests.tabs.docs'), indicator: mark(request.description) },
    settings: { label: t('apiTests.protocol.settings') },
  };

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col"
      aria-label={t('apiTests.request')}
      data-testid={`request-pane-${kind}`}
    >
      <PaneTabs
        label={t('apiTests.request')}
        value={tab}
        onChange={setChosen}
        tabs={KIND_TABS[kind].map((id) => ({ id, ...tabInfo[id] }))}
      />
      {/* Docs fill the pane and scroll inside themselves; the other tabs scroll as a whole. */}
      <div
        className={cn('min-h-0 flex-1 p-3', tab === 'docs' ? 'overflow-hidden' : 'overflow-y-auto')}
        role="tabpanel"
      >
        {tab === 'query' && (
          <div className="flex flex-col gap-6">
            <KeyValueEditor
              rows={request.query}
              readOnly={readOnly}
              onChange={(query) => set({ query })}
            />
            {/* Path params follow the `:name` segments of the URL, as in Bruno. */}
            {pathParams.length > 0 && (
              <div className="flex flex-col gap-2" data-testid="path-params">
                <h3 className="text-xs font-semibold text-[var(--text-primary)]">
                  {t('apiTests.ui.pathParams')}
                </h3>
                <p className="text-xs text-[var(--text-muted)]">
                  {t('apiTests.ui.pathParamsHint')}
                </p>
                <KeyValueEditor
                  lockKeys
                  rows={pathParams}
                  readOnly={readOnly}
                  onChange={(rows) => set({ pathParams: rows })}
                />
              </div>
            )}
          </div>
        )}
        {tab === 'body' && <BodyEditor request={request} {...editorProps} />}
        {tab === 'gqlQuery' && (
          <GraphqlQueryTab request={request} actions={actions} {...editorProps} />
        )}
        {tab === 'gqlVariables' && <GraphqlVariablesTab request={request} {...editorProps} />}
        {tab === 'message' && (
          <GrpcMessageTab request={request} collection={collection ?? {}} {...editorProps} />
        )}
        {tab === 'messages' &&
          (kind === 'socket' ? (
            <MessagesEditor
              protocol="socket"
              messages={socket.messages}
              readOnly={readOnly}
              onChange={(messages) => set({ socket: { ...socket, messages } })}
            />
          ) : (
            <MessagesEditor
              protocol="websocket"
              messages={websocket.messages}
              readOnly={readOnly}
              onChange={(messages) => set({ websocket: { ...websocket, messages } })}
            />
          ))}
        {tab === 'headers' && (
          <KeyValueEditor
            rows={request.headers}
            readOnly={readOnly}
            onChange={(headers) => set({ headers })}
          />
        )}
        {tab === 'auth' && (
          <AuthEditor
            auth={request.auth}
            allowInherit
            readOnly={readOnly}
            owner={request.id}
            personalSecrets={collection?.personalSecrets}
            onClearPersonal={onClearPersonal}
            inherited={collection ? inheritedAuth(collection, request.id) : null}
            onChange={(auth) => set({ auth })}
          />
        )}
        {tab === 'vars' && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-[var(--text-muted)]">{t('apiTests.protocol.varsHint')}</p>
            <KeyValueEditor
              rows={request.vars ?? []}
              readOnly={readOnly}
              onChange={(vars) => set({ vars })}
            />
          </div>
        )}
        {(tab === 'script' || tab === 'tests') && (
          <ScriptEditor
            key={tab}
            section={tab}
            scripts={request.scripts}
            readOnly={readOnly}
            onChange={(scripts) => set({ scripts })}
          />
        )}
        {tab === 'captures' && (
          <CapturesEditor
            captures={request.captures}
            readOnly={readOnly}
            onChange={(captures) => set({ captures })}
          />
        )}
        {tab === 'assertions' && (
          <AssertionsEditor
            assertions={request.assertions}
            readOnly={readOnly}
            onChange={(assertions) => set({ assertions })}
          />
        )}
        {tab === 'docs' && (
          <DocsEditor
            value={request.description ?? ''}
            readOnly={readOnly}
            hint={t('apiTests.workbench.docsHint')}
            onChange={(description) => set({ description })}
            data-testid="request-docs"
          />
        )}
        {tab === 'settings' && (
          <RequestSettingsEditor
            request={request}
            collection={collection}
            readOnly={readOnly}
            onChange={onChange}
          />
        )}
      </div>
    </section>
  );
}
