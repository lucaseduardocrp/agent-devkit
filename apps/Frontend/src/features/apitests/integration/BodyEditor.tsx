import React, { useRef } from 'react';
import { Select } from '../../../components/ui/select.js';
import { useI18n } from '../../../lib/i18n/index.js';
import type { ApiMockValue, ApiRequestSpec, RequestBody } from '../api-test-types.js';
import { KeyValueEditor } from '../ApiTestShared.js';
import { CodeEditor, type CodeEditorHandle } from './CodeEditor.js';
import { CodeEditorToolbar } from './CodeEditorToolbar.js';
import { FilePicker, MultipartEditor } from './MultipartEditor.js';
import { changeBodyMode } from './protocol-model.js';

const MODES: readonly { readonly mode: RequestBody['mode']; readonly label?: string }[] = [
  { mode: 'none' },
  { mode: 'json', label: 'JSON' },
  { mode: 'xml', label: 'XML' },
  { mode: 'text', label: 'Text' },
  { mode: 'sparql', label: 'SPARQL' },
  { mode: 'urlencoded', label: 'Form URL Encoded' },
  { mode: 'form', label: 'Multipart Form' },
  { mode: 'binary' },
];

/** The Body tab: the type, then a code editor, the fields, or the file. */
export function BodyEditor({
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
  const body = request.body;
  const set = (next: RequestBody) => onChange({ ...request, body: next });
  const textBody = 'content' in body ? body : null;
  const language = body.mode === 'json' || body.mode === 'xml' ? body.mode : 'text';
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center gap-2">
        <Select
          aria-label={t('apiTests.bodyMode')}
          containerClassName="w-56"
          value={body.mode}
          disabled={readOnly}
          onChange={(event) => set(changeBodyMode(body, event.target.value as RequestBody['mode']))}
        >
          {MODES.map(({ mode, label }) => (
            <option key={mode} value={mode}>
              {mode === 'none'
                ? t('apiTests.body.none')
                : mode === 'binary'
                  ? t('apiTests.protocol.binaryFile')
                  : label}
            </option>
          ))}
        </Select>
        {textBody && (
          <CodeEditorToolbar
            editor={editor}
            language={language}
            readOnly={readOnly}
            mocks={mocks}
            mocksFailed={mocksFailed}
            onRetryMocks={onRetryMocks}
          />
        )}
      </div>
      {textBody && (
        <CodeEditor
          ref={editor}
          label={t('apiTests.tabs.body')}
          value={textBody.content}
          language={language}
          readOnly={readOnly}
          mocks={mocks}
          placeholder={
            textBody.mode === 'json'
              ? '{\n  "name": "{{$randomFullName}}"\n}'
              : textBody.mode === 'sparql'
                ? 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 10'
                : ''
          }
          onChange={(content) => set({ mode: textBody.mode, content })}
        />
      )}
      {body.mode === 'urlencoded' && (
        <KeyValueEditor
          rows={body.fields}
          readOnly={readOnly}
          onChange={(fields) => set({ mode: 'urlencoded', fields })}
        />
      )}
      {body.mode === 'form' && (
        <MultipartEditor
          fields={body.fields}
          readOnly={readOnly}
          onChange={(fields) => set({ mode: 'form', fields })}
        />
      )}
      {body.mode === 'binary' && (
        <div className="flex flex-col gap-2" data-testid="binary-body">
          <FilePicker
            file={body.file}
            readOnly={readOnly}
            label={t('apiTests.protocol.binaryFile')}
            testId="binary-file"
            onChange={(file) => set({ mode: 'binary', file })}
          />
          <p className="text-xs text-[var(--text-muted)]">{t('apiTests.protocol.binaryHint')}</p>
        </div>
      )}
      {body.mode === 'none' && (
        <p className="text-xs text-[var(--text-muted)]">{t('apiTests.noBodyHint')}</p>
      )}
    </div>
  );
}
