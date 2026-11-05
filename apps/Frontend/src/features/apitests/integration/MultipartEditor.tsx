import React, { useId, useRef, useState } from 'react';
import { Button } from '../../../components/ui/button.js';
import { IconButton } from '../../../components/ui/icon-button.js';
import { Input } from '../../../components/ui/input.js';
import { Select } from '../../../components/ui/select.js';
import { useI18n } from '../../../lib/i18n/index.js';
import type { FileValue, FormField } from '../api-test-types.js';
import { VariableInput } from '../VariableInput.js';
import { readFileBase64 } from './file-read.js';
import { formatSize } from './integration-model.js';
import { MAX_FILE_BYTES, base64Bytes } from './protocol-model.js';

/** A button that picks a file from the disk and gives it as a FileValue, within MAX_FILE_BYTES. */
export function FilePicker({
  file,
  readOnly,
  label,
  onChange,
  testId,
}: {
  readonly file: FileValue | null | undefined;
  readonly readOnly: boolean;
  readonly label: string;
  readonly onChange: (file: FileValue | null) => void;
  readonly testId?: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const [error, setError] = useState<string | null>(null);
  const pick = async (picked: File | undefined) => {
    if (!picked) return;
    if (picked.size > MAX_FILE_BYTES) {
      setError(
        t('apiTests.protocol.fileTooLarge', {
          name: picked.name,
          max: formatSize(MAX_FILE_BYTES),
        }),
      );
      return;
    }
    try {
      const data = await readFileBase64(picked);
      setError(null);
      onChange({
        fileName: picked.name,
        ...(picked.type ? { contentType: picked.type } : {}),
        data,
      });
    } catch {
      setError(t('apiTests.protocol.fileReadFailed', { name: picked.name }));
    }
  };
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <input
          ref={input}
          type="file"
          className="hidden"
          aria-label={label}
          aria-describedby={error ? errorId : undefined}
          disabled={readOnly}
          data-testid={testId}
          onChange={(event) => {
            void pick(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={readOnly}
          onClick={() => input.current?.click()}
        >
          <i className="ti ti-paperclip" aria-hidden="true" />
          {file ? t('apiTests.protocol.replaceFile') : t('apiTests.protocol.chooseFile')}
        </Button>
        {file ? (
          <span className="min-w-0 truncate font-mono text-xs text-[var(--text-secondary)]">
            {file.fileName} · {formatSize(base64Bytes(file.data))}
          </span>
        ) : (
          <span className="text-xs text-[var(--text-muted)]">
            {t('apiTests.protocol.noFile', { max: formatSize(MAX_FILE_BYTES) })}
          </span>
        )}
        {file && !readOnly && (
          <IconButton
            variant="ghost"
            icon={<i className="ti ti-x text-sm" aria-hidden="true" />}
            label={t('apiTests.protocol.removeFile')}
            onClick={() => onChange(null)}
          />
        )}
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-xs text-[var(--text-danger)]">
          {error}
        </p>
      )}
    </div>
  );
}

/** The parts of a multipart form: text values or files, each with an optional content type. */
export function MultipartEditor({
  fields,
  readOnly,
  onChange,
}: {
  readonly fields: readonly FormField[];
  readonly readOnly: boolean;
  readonly onChange: (fields: FormField[]) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const update = (index: number, patch: Partial<FormField>) =>
    onChange(
      fields.map((field, position) => (position === index ? { ...field, ...patch } : field)),
    );
  return (
    <div className="flex flex-col gap-2" data-testid="multipart-editor">
      {fields.map((field, index) => {
        const isFile = field.type === 'file';
        const name = field.key || `#${index + 1}`;
        return (
          <div key={index} className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-3"
              aria-label={t('apiTests.enabled')}
              checked={field.enabled !== false}
              disabled={readOnly}
              onChange={(event) =>
                update(index, { enabled: event.target.checked ? undefined : false })
              }
            />
            <div className="w-48 shrink-0">
              <VariableInput
                mono
                aria-label={t('apiTests.key')}
                placeholder={t('apiTests.key')}
                value={field.key}
                disabled={readOnly}
                onValueChange={(key) => update(index, { key })}
              />
            </div>
            <Select
              aria-label={t('apiTests.protocol.partType', { name })}
              containerClassName="w-24 shrink-0"
              value={isFile ? 'file' : 'text'}
              disabled={readOnly}
              onChange={(event) =>
                event.target.value === 'file'
                  ? update(index, { type: 'file', value: '' })
                  : update(index, { type: 'text', file: undefined })
              }
            >
              <option value="text">{t('apiTests.protocol.partText')}</option>
              <option value="file">{t('apiTests.protocol.partFile')}</option>
            </Select>
            {isFile ? (
              <div className="flex min-h-10 min-w-0 flex-1 items-center">
                <FilePicker
                  file={field.file}
                  readOnly={readOnly}
                  label={t('apiTests.protocol.partFileOf', { name })}
                  testId={`multipart-file-${index}`}
                  onChange={(file) => update(index, { file: file ?? undefined })}
                />
              </div>
            ) : (
              <VariableInput
                mono
                aria-label={field.key || t('apiTests.value')}
                placeholder={t('apiTests.value')}
                value={field.value}
                disabled={readOnly}
                onValueChange={(value) => update(index, { value })}
              />
            )}
            <Input
              className="w-40 shrink-0 font-mono"
              aria-label={t('apiTests.protocol.partContentType', { name })}
              placeholder={t('apiTests.protocol.contentTypeAuto')}
              value={field.contentType ?? ''}
              disabled={readOnly}
              onChange={(event) => update(index, { contentType: event.target.value || undefined })}
            />
            {!readOnly && (
              <IconButton
                variant="ghost"
                icon={
                  <i className="ti ti-trash text-sm text-[var(--text-danger)]" aria-hidden="true" />
                }
                label={t('apiTests.remove')}
                onClick={() => onChange(fields.filter((_, position) => position !== index))}
              />
            )}
          </div>
        );
      })}
      {!readOnly && (
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            onClick={() => onChange([...fields, { key: '', value: '', type: 'text' }])}
          >
            <i className="ti ti-plus" aria-hidden="true" />
            {t('apiTests.protocol.addTextPart')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            onClick={() => onChange([...fields, { key: '', value: '', type: 'file' }])}
          >
            <i className="ti ti-paperclip" aria-hidden="true" />
            {t('apiTests.protocol.addFilePart')}
          </Button>
        </div>
      )}
    </div>
  );
}
