import React, { useRef, useState } from 'react';
import { IconButton } from '../../../components/ui/icon-button.js';
import { SearchableSelect } from '../../../components/ui/searchable-select.js';
import { Select } from '../../../components/ui/select.js';
import { useI18n } from '../../../lib/i18n/index.js';
import type {
  ApiCollection,
  ApiMockValue,
  ApiRequestSpec,
  GrpcServiceList,
  GrpcSpec,
} from '../api-test-types.js';
import { CodeEditor, type CodeEditorHandle } from './CodeEditor.js';
import { CodeEditorToolbar } from './CodeEditorToolbar.js';
import {
  grpcServicesCache,
  grpcMethodInfo,
  grpcSpec,
  sourceKey,
  streamingKind,
} from './protocol-model.js';
import type { RequestActions } from './request-actions.js';

type ListState =
  | { readonly status: 'idle' | 'loading' }
  | { readonly status: 'ready'; readonly list: GrpcServiceList }
  | { readonly status: 'error'; readonly message: string };

/** The `package.Service/Method` picker of the URL bar, loaded on first focus. */
export function GrpcMethodPicker({
  request,
  readOnly,
  actions,
  onChange,
}: {
  readonly request: ApiRequestSpec;
  readonly readOnly: boolean;
  readonly actions?: RequestActions;
  readonly onChange: (request: ApiRequestSpec) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const key = sourceKey(request);
  const [state, setState] = useState<{ key: string; value: ListState }>({
    key: '',
    value: { status: 'idle' },
  });
  const loading = useRef(false);
  const cached = grpcServicesCache.get(key);
  const current: ListState = cached
    ? { status: 'ready', list: cached }
    : state.key === key
      ? state.value
      : { status: 'idle' };
  const spec = grpcSpec(request);

  const load = () => {
    if (!actions || loading.current) return;
    loading.current = true;
    setState({ key, value: { status: 'loading' } });
    actions
      .listGrpcServices(request)
      .then((list) => {
        grpcServicesCache.set(key, list);
        setState({ key, value: { status: 'ready', list } });
      })
      .catch((error: unknown) =>
        setState({
          key,
          value: {
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      )
      .finally(() => {
        loading.current = false;
      });
  };

  const methods = current.status === 'ready' ? current.list.services.flatMap((s) => s.methods) : [];
  const options = methods.map((method) => {
    const kind = streamingKind(method);
    return {
      value: method.path,
      label:
        kind === 'unary'
          ? method.path
          : `${method.path} · ${t(`apiTests.protocol.streaming.${kind}`)}`,
    };
  });
  if (spec.method && !options.some((option) => option.value === spec.method))
    options.unshift({ value: spec.method, label: spec.method });

  const choose = (path: string) => {
    const method = methods.find((item) => item.path === path);
    const empty =
      !spec.message.trim() || spec.message.trim() === '{}' || spec.message.trim() === '[]';
    const example =
      method && empty
        ? JSON.stringify(method.clientStreaming ? [method.example] : method.example, null, 2)
        : spec.message;
    onChange({ ...request, grpc: { ...spec, method: path, message: example } });
  };

  return (
    <div className="flex shrink-0 flex-col gap-1" data-testid="grpc-method-picker">
      <div
        className="flex items-center gap-1"
        onFocusCapture={() => current.status === 'idle' && load()}
      >
        <div className="w-80">
          <SearchableSelect
            label={t('apiTests.protocol.grpcMethod')}
            placeholder={
              current.status === 'loading'
                ? t('apiTests.protocol.loadingMethods')
                : t('apiTests.protocol.selectMethod')
            }
            emptyMessage={
              current.status === 'ready'
                ? t('apiTests.ui.noMatches')
                : t('apiTests.protocol.noMethodsLoaded')
            }
            className="font-mono text-xs"
            value={spec.method}
            disabled={readOnly}
            options={options}
            onChange={(path) => path && choose(path)}
            data-testid="grpc-method-select"
          />
        </div>
        {actions && (
          <IconButton
            variant="ghost"
            icon={
              <i
                className={
                  current.status === 'loading'
                    ? 'ti ti-loader-2 animate-spin text-sm'
                    : 'ti ti-refresh text-sm'
                }
                aria-hidden="true"
              />
            }
            label={t('apiTests.protocol.reloadMethods')}
            title={t('apiTests.protocol.reloadMethods')}
            disabled={current.status === 'loading'}
            onClick={() => {
              grpcServicesCache.delete(key);
              load();
            }}
            data-testid="grpc-reload-methods"
          />
        )}
      </div>
      {current.status === 'error' && (
        <p role="alert" className="max-w-[22rem] text-xs text-[var(--text-danger)]">
          {t('apiTests.protocol.methodsFailed', { error: current.message })}
        </p>
      )}
    </div>
  );
}

/** The Message tab of a gRPC request: the definition source and the JSON message(s). */
export function GrpcMessageTab({
  request,
  collection,
  readOnly,
  mocks,
  mocksFailed,
  onRetryMocks,
  onChange,
}: {
  readonly request: ApiRequestSpec;
  readonly collection: Pick<ApiCollection, 'protoFiles'>;
  readonly readOnly: boolean;
  readonly mocks: readonly ApiMockValue[] | null;
  readonly mocksFailed: boolean;
  readonly onRetryMocks: () => void;
  readonly onChange: (request: ApiRequestSpec) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const editor = useRef<CodeEditorHandle>(null);
  const spec = grpcSpec(request);
  const set = (patch: Partial<GrpcSpec>) => onChange({ ...request, grpc: { ...spec, ...patch } });
  const method = grpcMethodInfo(request);
  const kind = method ? streamingKind(method) : null;
  const many = kind === 'client' || kind === 'bidi' || spec.message.trim().startsWith('[');
  const protoFiles = collection.protoFiles ?? [];
  const source = spec.reflection === false ? `proto:${spec.protoFile ?? ''}` : 'reflection';
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          selectSize="sm"
          containerClassName="w-56"
          aria-label={t('apiTests.protocol.definition')}
          value={source}
          disabled={readOnly}
          onChange={(event) => {
            const value = event.target.value;
            if (value === 'reflection') set({ reflection: true, protoFile: undefined });
            else set({ reflection: false, protoFile: value.slice('proto:'.length) || undefined });
          }}
          data-testid="grpc-source"
        >
          <option value="reflection">{t('apiTests.protocol.reflection')}</option>
          {protoFiles.map((file) => (
            <option key={file.name} value={`proto:${file.name}`}>
              {file.name}
            </option>
          ))}
          {spec.reflection === false &&
            !protoFiles.some((file) => file.name === spec.protoFile) && (
              <option value={source}>
                {spec.protoFile ?? t('apiTests.protocol.allProtoFiles')}
              </option>
            )}
        </Select>
        <CodeEditorToolbar
          editor={editor}
          language="json"
          readOnly={readOnly}
          mocks={mocks}
          mocksFailed={mocksFailed}
          onRetryMocks={onRetryMocks}
        />
        {method && (
          <span className="ml-auto font-mono text-[11px] text-[var(--text-muted)]">
            {method.requestType} → {method.responseType}
          </span>
        )}
      </div>
      {spec.reflection === false && !protoFiles.length && (
        <p role="note" className="text-xs text-[var(--text-warning)]">
          {t('apiTests.protocol.noProtoFiles')}
        </p>
      )}
      {many && (
        <p className="text-xs text-[var(--text-muted)]" data-testid="grpc-stream-hint">
          {t('apiTests.protocol.streamHint')}
        </p>
      )}
      <CodeEditor
        ref={editor}
        label={t('apiTests.protocol.message')}
        language="json"
        value={spec.message}
        readOnly={readOnly}
        mocks={mocks}
        placeholder={many ? '[\n  { "name": "first" }\n]' : '{\n  "name": "{{$randomFullName}}"\n}'}
        onChange={(message) => set({ message })}
      />
    </div>
  );
}
