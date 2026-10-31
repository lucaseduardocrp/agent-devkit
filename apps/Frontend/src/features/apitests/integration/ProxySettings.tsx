import React from 'react';
import { Input } from '../../../components/ui/input.js';
import { Select } from '../../../components/ui/select.js';
import { useI18n } from '../../../lib/i18n/index.js';
import { secretRef, type ProxySettings as Proxy } from '../api-test-types.js';
import { VariableInput } from '../VariableInput.js';
import { CheckboxField, SectionTitle, SettingField } from './integration-parts.js';
import { PersonalHint, PersonalSecretField } from './PersonalSecretField.js';

const PROTOCOLS = ['http', 'https', 'socks4', 'socks5'] as const;
const blank: Proxy = { enabled: false, protocol: 'http', hostname: '', port: 8080 };

/** The proxy the collection's requests go through; its credentials are personal. */
export function ProxySettings({
  proxy,
  onChange,
  readOnly,
  personalSecrets,
  onClearPersonal,
}: {
  readonly proxy: Proxy | undefined;
  readonly onChange: (proxy: Proxy) => void;
  readonly readOnly: boolean;
  readonly personalSecrets?: readonly string[];
  readonly onClearPersonal?: (ref: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const value = proxy ?? blank;
  const set = (patch: Partial<Proxy>) => onChange({ ...value, ...patch });
  const off = readOnly || !value.enabled;
  const secret = (field: 'username' | 'password', label: string) => {
    const ref = secretRef.proxy(field);
    return (
      <PersonalSecretField
        label={label}
        value={value[field] ?? ''}
        personal={Boolean(personalSecrets?.includes(ref))}
        onClear={onClearPersonal ? () => onClearPersonal(ref) : undefined}
        readOnly={off}
        mono={field === 'password'}
        onValueChange={(next) => set({ [field]: next })}
        testId={`proxy-${field}`}
      />
    );
  };
  return (
    <div className="flex flex-col gap-4" data-testid="proxy-settings">
      <SectionTitle
        title={t('apiTests.workbench.proxy')}
        hint={t('apiTests.workbench.proxyHint')}
      />
      <CheckboxField
        label={t('apiTests.workbench.proxyEnabled')}
        checked={value.enabled}
        disabled={readOnly}
        onChange={(enabled) => set({ enabled })}
        testId="proxy-enabled"
      />
      <div className="grid grid-cols-[140px_1fr_110px] gap-3">
        <SettingField label={t('apiTests.workbench.protocol')}>
          <Select
            aria-label={t('apiTests.workbench.protocol')}
            value={value.protocol}
            disabled={off}
            onChange={(event) => set({ protocol: event.target.value as Proxy['protocol'] })}
          >
            {PROTOCOLS.map((protocol) => (
              <option key={protocol} value={protocol}>
                {protocol.toUpperCase()}
              </option>
            ))}
          </Select>
        </SettingField>
        <SettingField label={t('apiTests.workbench.host')}>
          <VariableInput
            mono
            aria-label={t('apiTests.workbench.host')}
            value={value.hostname}
            placeholder="proxy.example.com"
            disabled={off}
            onValueChange={(hostname) => set({ hostname })}
          />
        </SettingField>
        <SettingField label={t('apiTests.workbench.port')}>
          <Input
            type="number"
            min={1}
            max={65535}
            aria-label={t('apiTests.workbench.port')}
            value={value.port || ''}
            disabled={off}
            onChange={(event) => set({ port: Number(event.target.value) || 0 })}
          />
        </SettingField>
      </div>
      <PersonalHint />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {secret('username', t('apiTests.username'))}
        {secret('password', t('apiTests.ui.password'))}
      </div>
      <SettingField
        label={t('apiTests.workbench.bypass')}
        hint={t('apiTests.workbench.bypassHint')}
      >
        <Input
          className="font-mono"
          aria-label={t('apiTests.workbench.bypass')}
          value={value.bypass ?? ''}
          placeholder="localhost, *.internal"
          disabled={off}
          onChange={(event) => set({ bypass: event.target.value })}
        />
      </SettingField>
    </div>
  );
}
