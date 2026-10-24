import React, { useId, useState } from 'react';
import { Button } from '../../../components/ui/button.js';
import { IconButton } from '../../../components/ui/icon-button.js';
import { Input } from '../../../components/ui/input.js';
import { Modal } from '../../../components/ui/modal.js';
import { SearchableSelect } from '../../../components/ui/searchable-select.js';
import { Select } from '../../../components/ui/select.js';
import { Textarea } from '../../../components/ui/textarea.js';
import { useI18n } from '../../../lib/i18n/index.js';
import { cn } from '../../../lib/utils.js';
import { RenderedCode } from '../../brain/RenderedCode.js';
import {
  ASSERTION_OPERATORS,
  ASSERTION_SOURCES,
  HTTP_METHODS,
  type ApiCollection,
  type ApiRequestSpec,
  type Assertion,
  type Capture,
  type RequestAuth,
  type RequestBody,
} from '../api-test-types.js';
import { KeyValueEditor } from '../ApiTestShared.js';
import { VariableInput } from '../VariableInput.js';
import {
  METHOD_COLOR,
  composeUrl,
  sameUrl,
  splitUrl,
  syncPathParams,
  toCurl,
} from './integration-model.js';
import { PaneTabs } from './integration-parts.js';

// ---------- URL bar ----------

export function UrlBar({
  request,
  collection,
  readOnly,
  dirty,
  sending,
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
  readonly onChange: (request: ApiRequestSpec) => void;
  readonly onSend: () => void;
  readonly onCancel: () => void;
  readonly onSave: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
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
    <div className="flex shrink-0 items-center gap-2 px-3 py-2.5" data-testid="request-editor">
      <div className="flex min-w-0 flex-1 items-center">
        <div className="w-[124px] shrink-0">
          <SearchableSelect
            label={t('apiTests.method')}
            placeholder={t('apiTests.method')}
            emptyMessage={t('apiTests.ui.noMatches')}
            className="rounded-r-none font-mono font-bold"
            value={request.method}
            disabled={readOnly}
            options={HTTP_METHODS.map((method) => ({
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
        <VariableInput
          mono
          aria-label="URL"
          containerClassName="-ml-px"
          className="rounded-l-none"
          value={shown}
          disabled={readOnly}
          placeholder={t('apiTests.ui.urlPlaceholder')}
          onValueChange={changeUrl}
          onBlur={() => setDraft(null)}
        />
      </div>
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
            <i className="ti ti-send" aria-hidden="true" />
            {t('apiTests.send')}
          </Button>
        ))}
      <CodeDialog
        open={showCode}
        code={toCurl(request, collection)}
        onClose={() => setShowCode(false)}
      />
    </div>
  );
}

function CodeDialog({
  open,
  code,
  onClose,
}: {
  readonly open: boolean;
  readonly code: string;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const id = useId();
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  return (
    <Modal open={open} onClose={onClose} labelledBy={id}>
      <div
        className="flex max-h-[calc(100vh-2rem)] w-[min(94vw,720px)] flex-col gap-4 rounded-lg border border-border bg-surface-1 p-6 shadow-2xl"
        data-testid="code-dialog"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 id={id} className="text-lg font-semibold text-[var(--text-primary)]">
            {t('apiTests.ui.generateCode')} · cURL
          </h2>
          <IconButton
            icon={<i className="ti ti-x" aria-hidden="true" />}
            label={t('apiTests.close')}
            onClick={onClose}
          />
        </div>
        <div className="min-h-0 overflow-auto rounded-md border border-[var(--border)] bg-[var(--surface-0)]">
          <RenderedCode code={code} language="bash" />
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

/** Text with line numbers, for request bodies. */
export function CodeArea({
  value,
  onChange,
  readOnly,
  placeholder,
  label,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly readOnly: boolean;
  readonly placeholder?: string;
  readonly label: string;
}): React.JSX.Element {
  const lines = Math.max(1, value.split('\n').length);
  return (
    <div className="flex min-h-[220px] flex-1 overflow-auto rounded-md border border-[var(--border)] bg-[var(--surface-2)] focus-within:border-[var(--border-accent)]">
      <div
        aria-hidden="true"
        className="select-none border-r border-[var(--border)] px-2 py-2 text-right font-mono text-xs leading-5 text-[var(--text-muted)]"
      >
        {Array.from({ length: lines }, (_, index) => (
          <div key={index}>{index + 1}</div>
        ))}
      </div>
      <Textarea
        aria-label={label}
        spellCheck={false}
        wrap="off"
        className="min-h-full flex-1 resize-none rounded-none border-0 bg-transparent px-3 py-2 font-mono text-xs leading-5 shadow-none focus-visible:ring-0"
        style={{ height: `${lines * 20 + 16}px` }}
        value={value}
        disabled={readOnly}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function AuthEditor({
  auth,
  onChange,
  readOnly,
  allowInherit,
}: {
  readonly auth: RequestAuth;
  readonly onChange: (auth: RequestAuth) => void;
  readonly readOnly: boolean;
  readonly allowInherit: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const setType = (type: RequestAuth['type']) => {
    if (type === 'bearer') return onChange({ type, token: '{{token}}' });
    if (type === 'basic') return onChange({ type, username: '', password: '' });
    if (type === 'apikey') return onChange({ type, key: 'X-API-Key', value: '', in: 'header' });
    return onChange({ type });
  };
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <Select
        aria-label={t('apiTests.authType')}
        containerClassName="w-64"
        value={auth.type}
        disabled={readOnly}
        onChange={(event) => setType(event.target.value as RequestAuth['type'])}
      >
        {allowInherit && <option value="inherit">{t('apiTests.auth.inherit')}</option>}
        <option value="none">{t('apiTests.auth.none')}</option>
        <option value="bearer">Bearer token</option>
        <option value="basic">Basic</option>
        <option value="apikey">API key</option>
      </Select>
      {auth.type === 'inherit' && (
        <p className="text-xs text-[var(--text-secondary)]">{t('apiTests.ui.inheritHint')}</p>
      )}
      {auth.type === 'bearer' && (
        <label className="flex flex-col gap-1.5 text-xs text-[var(--text-secondary)]">
          Token
          <VariableInput
            mono
            aria-label="Token"
            value={auth.token}
            disabled={readOnly}
            placeholder="{{token}}"
            onValueChange={(token) => onChange({ ...auth, token })}
          />
        </label>
      )}
      {auth.type === 'basic' && (
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5 text-xs text-[var(--text-secondary)]">
            {t('apiTests.username')}
            <VariableInput
              aria-label={t('apiTests.username')}
              value={auth.username}
              disabled={readOnly}
              onValueChange={(username) => onChange({ ...auth, username })}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-xs text-[var(--text-secondary)]">
            {t('apiTests.ui.password')}
            <VariableInput
              mono
              aria-label={t('apiTests.ui.password')}
              value={auth.password}
              disabled={readOnly}
              placeholder="{{password}}"
              onValueChange={(password) => onChange({ ...auth, password })}
            />
          </label>
        </div>
      )}
      {auth.type === 'apikey' && (
        <div className="grid grid-cols-[1fr_1fr_140px] gap-3">
          <VariableInput
            aria-label={t('apiTests.key')}
            value={auth.key}
            disabled={readOnly}
            onValueChange={(key) => onChange({ ...auth, key })}
          />
          <VariableInput
            mono
            aria-label={t('apiTests.value')}
            value={auth.value}
            disabled={readOnly}
            placeholder="{{apiKey}}"
            onValueChange={(value) => onChange({ ...auth, value })}
          />
          <Select
            aria-label={t('apiTests.ui.addTo')}
            value={auth.in}
            disabled={readOnly}
            onChange={(event) =>
              onChange({ ...auth, in: event.target.value as 'header' | 'query' })
            }
          >
            <option value="header">Header</option>
            <option value="query">Query</option>
          </Select>
        </div>
      )}
      <p className="text-xs text-[var(--text-muted)]">{t('apiTests.variablesHint')}</p>
    </div>
  );
}

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

type RequestTab = 'query' | 'body' | 'headers' | 'auth' | 'captures' | 'assertions' | 'docs';

export function RequestPane({
  request,
  readOnly,
  onChange,
}: {
  readonly request: ApiRequestSpec;
  readonly readOnly: boolean;
  readonly onChange: (request: ApiRequestSpec) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [tab, setTab] = useState<RequestTab>(request.body.mode !== 'none' ? 'body' : 'query');
  const set = (patch: Partial<ApiRequestSpec>) => onChange({ ...request, ...patch });
  const pathParams = syncPathParams(request.url, request.pathParams);
  const textBody =
    request.body.mode === 'json' || request.body.mode === 'text' || request.body.mode === 'xml'
      ? request.body
      : null;
  const fieldBody =
    request.body.mode === 'form' || request.body.mode === 'urlencoded' ? request.body : null;
  const setBodyMode = (mode: RequestBody['mode']) =>
    set({
      body:
        mode === 'none'
          ? { mode }
          : mode === 'form' || mode === 'urlencoded'
            ? { mode, fields: fieldBody?.fields ?? [] }
            : { mode, content: textBody?.content ?? '' },
    });
  const beautify = () => {
    if (!textBody) return;
    try {
      set({
        body: {
          mode: textBody.mode,
          content: JSON.stringify(JSON.parse(textBody.content), null, 2),
        },
      });
    } catch {
      // Not valid JSON yet: leave it as typed.
    }
  };
  const enabled = (rows: readonly { enabled?: boolean }[]) =>
    rows.filter((row) => row.enabled !== false).length;

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col" aria-label={t('apiTests.request')}>
      <PaneTabs
        label={t('apiTests.request')}
        value={tab}
        onChange={setTab}
        tabs={[
          {
            id: 'query',
            label: t('apiTests.ui.query'),
            indicator: enabled(request.query) + pathParams.length,
          },
          {
            id: 'body',
            label: t('apiTests.tabs.body'),
            indicator: request.body.mode === 'none' ? '' : '•',
          },
          { id: 'headers', label: t('apiTests.tabs.headers'), indicator: enabled(request.headers) },
          {
            id: 'auth',
            label: t('apiTests.tabs.auth'),
            indicator: request.auth.type === 'inherit' || request.auth.type === 'none' ? '' : '•',
          },
          {
            id: 'captures',
            label: t('apiTests.tabs.captures'),
            indicator: request.captures.length,
          },
          {
            id: 'assertions',
            label: t('apiTests.tabs.assertions'),
            indicator: request.assertions.length,
          },
          { id: 'docs', label: t('apiTests.tabs.docs'), indicator: request.description ? '•' : '' },
        ]}
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-3" role="tabpanel">
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
            onChange={(auth) => set({ auth })}
          />
        )}
        {tab === 'body' && (
          <div className="flex h-full flex-col gap-2">
            <div className="flex items-center gap-2">
              <Select
                aria-label={t('apiTests.bodyMode')}
                containerClassName="w-56"
                value={request.body.mode}
                disabled={readOnly}
                onChange={(event) => setBodyMode(event.target.value as RequestBody['mode'])}
              >
                <option value="none">{t('apiTests.body.none')}</option>
                <option value="json">JSON</option>
                <option value="xml">XML</option>
                <option value="text">Text</option>
                <option value="urlencoded">Form URL Encoded</option>
                <option value="form">Multipart Form</option>
              </Select>
              {textBody?.mode === 'json' && !readOnly && (
                <Button variant="ghost" size="sm" onClick={beautify}>
                  <i className="ti ti-braces" aria-hidden="true" />
                  {t('apiTests.beautify')}
                </Button>
              )}
            </div>
            {textBody && (
              <CodeArea
                label={t('apiTests.tabs.body')}
                value={textBody.content}
                readOnly={readOnly}
                placeholder={textBody.mode === 'json' ? '{\n  "name": "{{name}}"\n}' : ''}
                onChange={(content) => set({ body: { mode: textBody.mode, content } })}
              />
            )}
            {fieldBody && (
              <KeyValueEditor
                rows={fieldBody.fields}
                readOnly={readOnly}
                onChange={(fields) => set({ body: { mode: fieldBody.mode, fields } })}
              />
            )}
            {request.body.mode === 'none' && (
              <p className="text-xs text-[var(--text-muted)]">{t('apiTests.noBodyHint')}</p>
            )}
          </div>
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
          <Textarea
            aria-label={t('apiTests.tabs.docs')}
            className="h-56 resize-none text-sm"
            value={request.description ?? ''}
            disabled={readOnly}
            placeholder={t('apiTests.descriptionPlaceholder')}
            onChange={(event) => set({ description: event.target.value })}
          />
        )}
      </div>
    </section>
  );
}
