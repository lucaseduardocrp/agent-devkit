import React, { useRef } from 'react';
import { Button } from '../../../components/ui/button.js';
import { IconButton } from '../../../components/ui/icon-button.js';
import { Input } from '../../../components/ui/input.js';
import { Select } from '../../../components/ui/select.js';
import { Textarea } from '../../../components/ui/textarea.js';
import { useI18n } from '../../../lib/i18n/index.js';
import { secretRef, type ClientCertificate, type CollectionSettings } from '../api-test-types.js';
import { readFileBase64, readFileText, errorText } from './file-read.js';
import { CheckboxField, SectionTitle, SettingField } from './integration-parts.js';
import { PersonalBadge, PersonalHint, PersonalSecretField } from './PersonalSecretField.js';

/** A button that opens the file picker and hands the picked file over. */
export function FileButton({
  label,
  accept,
  disabled,
  multiple,
  onFiles,
  testId,
}: {
  readonly label: string;
  readonly accept?: string;
  readonly disabled?: boolean;
  readonly multiple?: boolean;
  readonly onFiles: (files: File[]) => void;
  readonly testId?: string;
}): React.JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <i className="ti ti-file-upload" aria-hidden="true" />
        {label}
      </Button>
      <input
        ref={input}
        type="file"
        className="hidden"
        accept={accept}
        multiple={multiple}
        aria-label={label}
        data-testid={testId}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}

const blank = (): ClientCertificate => ({ domain: '', type: 'pem', cert: '', key: '' });

/**
 * Client certificates (mutual TLS), per domain. The certificate is shared; the private key, the
 * PFX file and its passphrase are personal.
 */
export function ClientCertificates({
  certificates,
  onChange,
  readOnly,
  personalSecrets,
  onClearPersonal,
  onError,
}: {
  readonly certificates: readonly ClientCertificate[];
  readonly onChange: (certificates: ClientCertificate[]) => void;
  readonly readOnly: boolean;
  readonly personalSecrets?: readonly string[];
  readonly onClearPersonal?: (ref: string) => void;
  readonly onError: (message: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const update = (index: number, patch: Partial<ClientCertificate>) =>
    onChange(
      certificates.map((item, position) => (position === index ? { ...item, ...patch } : item)),
    );
  const personal = (index: number, field: 'key' | 'pfx' | 'passphrase') =>
    Boolean(personalSecrets?.includes(secretRef.certificate(index, field)));
  const clear = (index: number, field: 'key' | 'pfx' | 'passphrase') =>
    onClearPersonal ? () => onClearPersonal(secretRef.certificate(index, field)) : undefined;
  const load = (files: File[], as: 'text' | 'base64', apply: (content: string) => void) =>
    void (as === 'text' ? readFileText(files[0]!) : readFileBase64(files[0]!))
      .then(apply)
      .catch((err: unknown) => onError(errorText(err)));

  return (
    <div className="flex flex-col gap-4" data-testid="client-certificates">
      <SectionTitle
        title={t('apiTests.workbench.clientCertificates')}
        hint={t('apiTests.workbench.clientCertificatesHint')}
      />
      <PersonalHint />
      {certificates.map((certificate, index) => (
        <div
          key={index}
          className="flex flex-col gap-3 rounded-md border border-[var(--border)] bg-[var(--surface-1)] p-3"
          data-testid="certificate"
        >
          <div className="flex items-end gap-3">
            <SettingField label={t('apiTests.workbench.domain')} className="flex-1">
              <Input
                className="font-mono"
                aria-label={t('apiTests.workbench.domain')}
                value={certificate.domain}
                placeholder="api.example.com"
                disabled={readOnly}
                onChange={(event) => update(index, { domain: event.target.value })}
              />
            </SettingField>
            <SettingField label={t('apiTests.workbench.certificateType')} className="w-32">
              <Select
                aria-label={t('apiTests.workbench.certificateType')}
                value={certificate.type}
                disabled={readOnly}
                onChange={(event) =>
                  update(index, { type: event.target.value as ClientCertificate['type'] })
                }
              >
                <option value="pem">PEM</option>
                <option value="pfx">PFX / P12</option>
              </Select>
            </SettingField>
            {!readOnly && (
              <IconButton
                variant="ghost"
                icon={
                  <i className="ti ti-trash text-sm text-[var(--text-danger)]" aria-hidden="true" />
                }
                label={t('apiTests.remove')}
                onClick={() => onChange(certificates.filter((_, position) => position !== index))}
              />
            )}
          </div>
          {certificate.type === 'pem' ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="flex flex-col gap-1.5 text-xs text-[var(--text-secondary)]">
                <span className="flex items-center justify-between gap-2">
                  {t('apiTests.workbench.certificate')}
                  {!readOnly && (
                    <FileButton
                      label={t('apiTests.workbench.loadFile')}
                      accept=".pem,.crt,.cer"
                      onFiles={(files) => load(files, 'text', (cert) => update(index, { cert }))}
                    />
                  )}
                </span>
                <Textarea
                  className="min-h-20 font-mono text-xs"
                  aria-label={t('apiTests.workbench.certificate')}
                  value={certificate.cert ?? ''}
                  placeholder="-----BEGIN CERTIFICATE-----"
                  spellCheck={false}
                  disabled={readOnly}
                  onChange={(event) => update(index, { cert: event.target.value })}
                />
              </div>
              <PersonalSecretField
                multiline
                label={t('apiTests.workbench.privateKey')}
                value={certificate.key ?? ''}
                personal={personal(index, 'key')}
                onClear={clear(index, 'key')}
                readOnly={readOnly}
                placeholder="-----BEGIN PRIVATE KEY-----"
                onValueChange={(key) => update(index, { key })}
                testId="certificate-key"
                action={
                  !readOnly && (
                    <FileButton
                      label={t('apiTests.workbench.loadFile')}
                      accept=".pem,.key"
                      onFiles={(files) => load(files, 'text', (key) => update(index, { key }))}
                    />
                  )
                }
              />
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--text-secondary)]">
              <span className="flex items-center gap-2">
                {t('apiTests.workbench.pfxFile')}
                {personal(index, 'pfx') && <PersonalBadge />}
              </span>
              <span className="text-[var(--text-muted)]" data-testid="pfx-state">
                {certificate.pfx
                  ? t('apiTests.workbench.fileLoaded')
                  : personal(index, 'pfx')
                    ? t('apiTests.workbench.personalPlaceholder')
                    : t('apiTests.workbench.noFile')}
              </span>
              {!readOnly && (
                <FileButton
                  label={t('apiTests.workbench.loadFile')}
                  accept=".pfx,.p12"
                  onFiles={(files) => load(files, 'base64', (pfx) => update(index, { pfx }))}
                />
              )}
              {personal(index, 'pfx') && !certificate.pfx && !readOnly && onClearPersonal && (
                <Button variant="ghost" size="sm" onClick={clear(index, 'pfx')}>
                  <i className="ti ti-eraser" aria-hidden="true" />
                  {t('apiTests.workbench.clearMyValue')}
                </Button>
              )}
            </div>
          )}
          <PersonalSecretField
            className="max-w-sm"
            label={t('apiTests.workbench.passphrase')}
            value={certificate.passphrase ?? ''}
            personal={personal(index, 'passphrase')}
            onClear={clear(index, 'passphrase')}
            readOnly={readOnly}
            onValueChange={(passphrase) => update(index, { passphrase })}
            testId="certificate-passphrase"
          />
        </div>
      ))}
      {!certificates.length && (
        <p className="text-xs text-[var(--text-muted)]">{t('apiTests.workbench.noCertificates')}</p>
      )}
      {!readOnly && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start text-xs"
          onClick={() => onChange([...certificates, blank()])}
          data-testid="add-certificate"
        >
          <i className="ti ti-plus mr-1" aria-hidden="true" />
          {t('apiTests.workbench.addCertificate')}
        </Button>
      )}
    </div>
  );
}

type Tls = NonNullable<CollectionSettings['tls']>;

/** Whether server certificates are checked, and the CA that signs private ones. */
export function TlsSettings({
  tls,
  onChange,
  readOnly,
  onError,
}: {
  readonly tls: Tls | undefined;
  readonly onChange: (tls: Tls) => void;
  readonly readOnly: boolean;
  readonly onError: (message: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const value = tls ?? {};
  return (
    <div className="flex flex-col gap-4" data-testid="tls-settings">
      <SectionTitle title={t('apiTests.workbench.tls')} hint={t('apiTests.workbench.tlsHint')} />
      <CheckboxField
        label={t('apiTests.workbench.verifyCertificates')}
        hint={t('apiTests.workbench.verifyCertificatesHint')}
        checked={value.verify !== false}
        disabled={readOnly}
        onChange={(verify) => onChange({ ...value, verify })}
        testId="tls-verify"
      />
      <div className="flex flex-col gap-1.5 text-xs text-[var(--text-secondary)]">
        <span className="flex items-center justify-between gap-2">
          {t('apiTests.workbench.caCertificate')}
          {!readOnly && (
            <FileButton
              label={t('apiTests.workbench.loadFile')}
              accept=".pem,.crt,.cer"
              onFiles={(files) =>
                void readFileText(files[0]!)
                  .then((caCertificate) => onChange({ ...value, caCertificate }))
                  .catch((err: unknown) => onError(errorText(err)))
              }
            />
          )}
        </span>
        <Textarea
          className="min-h-28 font-mono text-xs"
          aria-label={t('apiTests.workbench.caCertificate')}
          value={value.caCertificate ?? ''}
          placeholder="-----BEGIN CERTIFICATE-----"
          spellCheck={false}
          disabled={readOnly}
          onChange={(event) => onChange({ ...value, caCertificate: event.target.value })}
        />
        <span className="text-[11px] text-[var(--text-muted)]">
          {t('apiTests.workbench.caCertificateHint')}
        </span>
      </div>
    </div>
  );
}
