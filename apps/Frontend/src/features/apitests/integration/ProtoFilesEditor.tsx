import React, { useState } from 'react';
import { Button } from '../../../components/ui/button.js';
import { IconButton } from '../../../components/ui/icon-button.js';
import { Input } from '../../../components/ui/input.js';
import { useI18n } from '../../../lib/i18n/index.js';
import { cn } from '../../../lib/utils.js';
import type { ProtoFile } from '../api-test-types.js';
import { FileButton } from './ClientCertificates.js';
import { CodeEditor } from './CodeEditor.js';
import { readFileText, relativeName, errorText } from './file-read.js';
import { SectionTitle } from './integration-parts.js';
import { formatSize } from './integration-model.js';

/**
 * The .proto files of the collection, used by gRPC requests whose server has no reflection.
 * Names are relative paths (`orders/v1/orders.proto`) so `import` statements resolve.
 */
export function ProtoFilesEditor({
  files,
  onChange,
  readOnly,
  onError,
}: {
  readonly files: readonly ProtoFile[];
  readonly onChange: (files: ProtoFile[]) => void;
  readonly readOnly: boolean;
  readonly onError: (message: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [selected, setSelected] = useState<number | null>(files.length ? 0 : null);
  const current = selected !== null ? files[selected] : undefined;
  const update = (index: number, patch: Partial<ProtoFile>) =>
    onChange(files.map((file, position) => (position === index ? { ...file, ...patch } : file)));

  const add = async (picked: File[]) => {
    try {
      const loaded = await Promise.all(
        picked.map(async (file) => ({
          name: relativeName(file),
          content: await readFileText(file),
        })),
      );
      // A file with the same name is replaced: picking it again updates it.
      const next = [...files];
      for (const file of loaded) {
        const index = next.findIndex((item) => item.name === file.name);
        if (index >= 0) next[index] = file;
        else next.push(file);
      }
      onChange(next);
      setSelected(next.findIndex((item) => item.name === loaded[0]!.name));
    } catch (err) {
      onError(errorText(err));
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="proto-files">
      <SectionTitle
        title={t('apiTests.workbench.protoFiles')}
        hint={t('apiTests.workbench.protoFilesHint')}
      />
      {!readOnly && (
        <div className="flex flex-wrap gap-2">
          <FileButton
            label={t('apiTests.workbench.addProtoFiles')}
            accept=".proto"
            multiple
            onFiles={(picked) => void add(picked)}
            testId="proto-input"
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onChange([
                ...files,
                { name: `file${files.length + 1}.proto`, content: 'syntax = "proto3";\n' },
              ]);
              setSelected(files.length);
            }}
          >
            <i className="ti ti-plus" aria-hidden="true" />
            {t('apiTests.workbench.newProtoFile')}
          </Button>
        </div>
      )}
      {files.length ? (
        <ul className="rounded-md border border-[var(--border)] bg-[var(--surface-1)]">
          {files.map((file, index) => (
            <li
              key={index}
              className={cn(
                'flex items-center gap-2 border-b border-[var(--border)] px-2 py-1.5 last:border-0',
                selected === index && 'bg-[var(--fill-ghost-selected)]',
              )}
              data-testid="proto-file"
            >
              <i className="ti ti-file-code text-sm text-[var(--text-muted)]" aria-hidden="true" />
              <Input
                inputSize="sm"
                className="font-mono text-xs"
                aria-label={t('apiTests.workbench.protoFileName')}
                value={file.name}
                disabled={readOnly}
                onChange={(event) => update(index, { name: event.target.value })}
              />
              <span className="shrink-0 font-mono text-[11px] text-[var(--text-muted)]">
                {formatSize(new Blob([file.content]).size)}
              </span>
              <IconButton
                size="sm"
                variant="ghost"
                icon={<i className="ti ti-pencil text-sm" aria-hidden="true" />}
                label={t('apiTests.workbench.editProtoFile', { name: file.name })}
                onClick={() => setSelected(index)}
              />
              {!readOnly && (
                <IconButton
                  size="sm"
                  variant="ghost"
                  icon={
                    <i
                      className="ti ti-trash text-sm text-[var(--text-danger)]"
                      aria-hidden="true"
                    />
                  }
                  label={t('apiTests.workbench.removeProtoFile', { name: file.name })}
                  onClick={() => {
                    onChange(files.filter((_, position) => position !== index));
                    setSelected(null);
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-[var(--text-muted)]">{t('apiTests.workbench.noProtoFiles')}</p>
      )}
      {current && selected !== null && (
        <CodeEditor
          key={selected}
          value={current.content}
          onChange={(content) => update(selected, { content })}
          readOnly={readOnly}
          language="text"
          label={current.name}
        />
      )}
    </div>
  );
}
