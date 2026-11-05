import React from 'react';
import { Input } from '../../../components/ui/input.js';
import { Select } from '../../../components/ui/select.js';
import { useI18n } from '../../../lib/i18n/index.js';
import type { ApiCollection, ApiRequestSpec, SocketSpec } from '../api-test-types.js';

/** Empty means "not set": the collection setting or the engine default applies. */
const toNumber = (text: string) => (text.trim() ? Math.max(0, Number(text)) : undefined);
const toList = (text: string) => {
  const items = text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
};

function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1.5 text-xs text-[var(--text-secondary)]">
      {label}
      {children}
      {hint && <span className="text-[11px] text-[var(--text-muted)]">{hint}</span>}
    </label>
  );
}

function NumberField({
  label,
  hint,
  value,
  placeholder,
  readOnly,
  onChange,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly value: number | undefined;
  readonly placeholder?: string;
  readonly readOnly: boolean;
  readonly onChange: (value: number | undefined) => void;
}): React.JSX.Element {
  return (
    <Field label={label} hint={hint}>
      <Input
        type="number"
        min={0}
        aria-label={label}
        value={value ?? ''}
        placeholder={placeholder}
        disabled={readOnly}
        onChange={(event) => onChange(toNumber(event.target.value))}
      />
    </Field>
  );
}

/** The Settings tab: timeout, redirects and URL encoding, the stream limits, the tags. */
export function RequestSettingsEditor({
  request,
  collection,
  readOnly,
  onChange,
}: {
  readonly request: ApiRequestSpec;
  readonly collection?: Pick<ApiCollection, 'settings'>;
  readonly readOnly: boolean;
  readonly onChange: (request: ApiRequestSpec) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const kind = request.kind ?? 'http';
  const settings = request.settings ?? {};
  const defaults = collection?.settings ?? {};
  const set = (patch: Partial<ApiRequestSpec>) => onChange({ ...request, ...patch });
  const setSettings = (patch: Partial<typeof settings>) =>
    set({ settings: { ...settings, ...patch } });
  const httpLike = kind === 'http' || kind === 'graphql' || kind === 'sse';
  const websocket = request.websocket ?? { messages: [] };
  const sse = request.sse ?? {};
  const socket = request.socket ?? { messages: [] };
  const inherit = t('apiTests.protocol.inheritSetting');

  return (
    <div className="grid max-w-3xl grid-cols-2 gap-4" data-testid="request-settings">
      <NumberField
        label={t('apiTests.protocol.timeoutMs')}
        value={request.timeoutMs}
        placeholder={defaults.timeoutMs ? String(defaults.timeoutMs) : inherit}
        readOnly={readOnly}
        onChange={(timeoutMs) => set({ timeoutMs })}
      />
      <Field label={t('apiTests.protocol.tags')} hint={t('apiTests.protocol.tagsHint')}>
        <Input
          aria-label={t('apiTests.protocol.tags')}
          value={(request.tags ?? []).join(', ')}
          placeholder="smoke, auth"
          disabled={readOnly}
          onChange={(event) => set({ tags: toList(event.target.value) })}
        />
      </Field>
      {httpLike && (
        <>
          <Field label={t('apiTests.protocol.followRedirects')}>
            <Select
              aria-label={t('apiTests.protocol.followRedirects')}
              value={settings.followRedirects === undefined ? '' : String(settings.followRedirects)}
              disabled={readOnly}
              onChange={(event) =>
                setSettings({
                  followRedirects: event.target.value ? event.target.value === 'true' : undefined,
                })
              }
            >
              <option value="">{inherit}</option>
              <option value="true">{t('common.yes')}</option>
              <option value="false">{t('common.no')}</option>
            </Select>
          </Field>
          <NumberField
            label={t('apiTests.protocol.maxRedirects')}
            value={settings.maxRedirects}
            placeholder={defaults.maxRedirects ? String(defaults.maxRedirects) : inherit}
            readOnly={readOnly}
            onChange={(maxRedirects) => setSettings({ maxRedirects })}
          />
          <label className="col-span-2 flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={settings.encodeUrl !== false}
              disabled={readOnly}
              onChange={(event) =>
                setSettings({ encodeUrl: event.target.checked ? undefined : false })
              }
            />
            {t('apiTests.protocol.encodeUrl')}
          </label>
        </>
      )}
      {kind === 'websocket' && (
        <>
          <Field label={t('apiTests.protocol.subprotocols')} hint={t('apiTests.protocol.tagsHint')}>
            <Input
              aria-label={t('apiTests.protocol.subprotocols')}
              value={(websocket.subprotocols ?? []).join(', ')}
              placeholder="graphql-ws"
              disabled={readOnly}
              onChange={(event) =>
                set({ websocket: { ...websocket, subprotocols: toList(event.target.value) } })
              }
            />
          </Field>
          <NumberField
            label={t('apiTests.protocol.listenMs')}
            hint={t('apiTests.protocol.listenHint')}
            value={websocket.listenMs}
            readOnly={readOnly}
            onChange={(listenMs) => set({ websocket: { ...websocket, listenMs } })}
          />
          <NumberField
            label={t('apiTests.protocol.maxMessages')}
            value={websocket.maxMessages}
            readOnly={readOnly}
            onChange={(maxMessages) => set({ websocket: { ...websocket, maxMessages } })}
          />
        </>
      )}
      {kind === 'sse' && (
        <>
          <NumberField
            label={t('apiTests.protocol.listenMs')}
            hint={t('apiTests.protocol.listenHint')}
            value={sse.listenMs}
            readOnly={readOnly}
            onChange={(listenMs) => set({ sse: { ...sse, listenMs } })}
          />
          <NumberField
            label={t('apiTests.protocol.maxEvents')}
            value={sse.maxEvents}
            readOnly={readOnly}
            onChange={(maxEvents) => set({ sse: { ...sse, maxEvents } })}
          />
        </>
      )}
      {kind === 'socket' && (
        <>
          <NumberField
            label={t('apiTests.protocol.listenMs')}
            hint={t('apiTests.protocol.listenHint')}
            value={socket.listenMs}
            readOnly={readOnly}
            onChange={(listenMs) => set({ socket: { ...socket, listenMs } })}
          />
          <Field
            label={t('apiTests.protocol.readUntil')}
            hint={t('apiTests.protocol.readUntilHint')}
          >
            <Input
              aria-label={t('apiTests.protocol.readUntil')}
              value={socket.readUntil ?? ''}
              placeholder="\n"
              disabled={readOnly}
              onChange={(event) =>
                set({ socket: { ...socket, readUntil: event.target.value || undefined } })
              }
            />
          </Field>
          <Field label={t('apiTests.protocol.responseEncoding')}>
            <Select
              aria-label={t('apiTests.protocol.responseEncoding')}
              value={socket.responseEncoding ?? 'text'}
              disabled={readOnly}
              onChange={(event) =>
                set({
                  socket: {
                    ...socket,
                    responseEncoding: event.target.value as SocketSpec['responseEncoding'],
                  },
                })
              }
            >
              <option value="text">{t('apiTests.protocol.messageTypes.text')}</option>
              <option value="hex">{t('apiTests.protocol.messageTypes.hex')}</option>
              <option value="base64">{t('apiTests.protocol.messageTypes.base64')}</option>
            </Select>
          </Field>
        </>
      )}
    </div>
  );
}
