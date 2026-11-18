import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { useI18n } from '../../lib/i18n/index.js';
import { extractPdfText } from '../../lib/pdf-text.js';
import { cn } from '../../lib/utils.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Modal } from '../../components/ui/modal.js';
import { MarkdownEditor } from '../shared/markdown-editor/MarkdownEditor.js';
import { discardDrafts, saveWithDrafts } from '../shared/media.js';
import {
  E2eSavedCasePicker,
  EMPTY_SAVED_SELECTION,
  type SavedCaseSelection,
} from './E2eSavedCasePicker.js';

type Source = 'prd' | 'saved';

const PRD_ACCEPT = '.md,.markdown,.pdf,.txt,.json,.yaml,.yml,.html,.htm,.csv,.xml,.feature';
const MAX_TEXT_FILE_BYTES = 2_000_000;
const MAX_PDF_BYTES = 10_000_000;
/** What the API accepts for a PRD. */
const MAX_PRD_LENGTH = 500_000;

interface PrdFile {
  readonly name: string;
  readonly content: string;
}

/** Saved cases as the API expects them: a Test Plan wins over its suite. */
function savedCases(saved: SavedCaseSelection) {
  return {
    ...(saved.planId ? { planId: saved.planId } : { suiteId: saved.suiteId }),
    ...(saved.caseIds ? { caseIds: saved.caseIds } : {}),
  };
}

async function readPrdFile(file: File): Promise<string> {
  const isPdf = /\.pdf$/i.test(file.name);
  if (file.size > (isPdf ? MAX_PDF_BYTES : MAX_TEXT_FILE_BYTES)) throw new Error('too large');
  return isPdf ? extractPdfText(file) : file.text();
}

/** The attached files and the written text as one document, the way a run keeps its PRD. */
function composePrd(files: readonly PrdFile[], text: string): string {
  return [...files.map((file) => `# ${file.name}\n\n${file.content}`), text.trim()]
    .filter(Boolean)
    .join('\n\n---\n\n');
}

/**
 * Writes the tests of a run when the user asks, from one of two sources: the agent plans them
 * from a PRD (attached files or text with images, only while the run has none, since that
 * replaces them), or the test cases saved in Test Plans are associated to the run and automated.
 */
export function E2eGenerateTestsDialog({
  apiClient,
  creationId,
  hasTests,
  onClose,
  onGenerated,
}: {
  readonly apiClient: ApiClient;
  readonly creationId: string;
  /** The run already has tests: planning again would replace them, so only cases can be added. */
  readonly hasTests: boolean;
  readonly onClose: () => void;
  readonly onGenerated: () => void;
}) {
  const { t } = useI18n();
  const [source, setSource] = useState<Source>(hasTests ? 'saved' : 'prd');
  const [saved, setSaved] = useState<SavedCaseSelection>(EMPTY_SAVED_SELECTION);
  const [files, setFiles] = useState<readonly PrdFile[]>([]);
  const [text, setText] = useState('');
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Images pasted in the text are only kept in this tab until the tests are generated.
  const draftText = useRef('');
  draftText.current = text;
  useEffect(() => () => discardDrafts(draftText.current), []);

  const prd = composePrd(files, text);
  const ready = source === 'prd' ? Boolean(prd) : Boolean(saved.suiteId || saved.planId);

  const addFiles = async (list: FileList | null) => {
    setFileError(null);
    setReading(true);
    const results = await Promise.all(
      Array.from(list ?? [], (file) =>
        readPrdFile(file).then(
          (content): PrdFile => ({ name: file.name, content }),
          () => {
            setFileError(t('e2e.fileReadFailed', { name: file.name }));
            return null;
          },
        ),
      ),
    );
    setReading(false);
    const read = results.filter((item): item is PrdFile => item !== null);
    if (!read.length) return;
    setFiles((current) => [
      ...current.filter((file) => !read.some((item) => item.name === file.name)),
      ...read,
    ]);
  };

  const onFilesChange = (event: ChangeEvent<HTMLInputElement>) => {
    void addFiles(event.target.files);
    event.target.value = '';
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void addFiles(event.dataTransfer.files);
  };

  /** `linkOnly` associates the saved cases to the run without writing or running their specs. */
  const submit = async (linkOnly = false) => {
    setError(null);
    if (source === 'prd' && prd.length > MAX_PRD_LENGTH) {
      setError(t('e2e.generatePrdTooLong'));
      return;
    }
    setSubmitting(true);
    try {
      if (source === 'saved' && linkOnly)
        await apiClient.linkE2eSavedCases(creationId, savedCases(saved));
      else if (source === 'saved')
        await apiClient.generateE2eTests(creationId, { savedCases: savedCases(saved) });
      else
        // The images pasted in the text are uploaded now and the text points at the stored files.
        await saveWithDrafts(apiClient, 'e2e', composePrd(files, text), (document) =>
          apiClient.generateE2eTests(creationId, {
            prd: document,
            prdFileNames: files.map((file) => file.name),
          }),
        );
      onGenerated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('e2e.generateFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const close = () => {
    discardDrafts(text);
    onClose();
  };

  const tabs: readonly { source: Source; label: string; disabled: boolean }[] = [
    { source: 'prd', label: t('e2e.generateTabPrd'), disabled: hasTests },
    { source: 'saved', label: t('e2e.generateTabPlans'), disabled: false },
  ];

  return (
    <Modal open labelledBy="generate-tests-title" onClose={close}>
      <div
        className="flex max-h-[90vh] w-[1040px] max-w-full flex-col gap-4 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-6"
        data-testid="e2e-generate-dialog"
      >
        <h2 id="generate-tests-title" className="text-lg font-semibold text-[var(--text-primary)]">
          {t('e2e.generateTitle')}
        </h2>
        <div className="flex gap-1 border-b border-[var(--border)]" role="tablist">
          {tabs.map((tab) => (
            <Button
              key={tab.source}
              variant="ghost"
              size="sm"
              role="tab"
              aria-selected={source === tab.source}
              disabled={tab.disabled}
              title={tab.disabled ? t('e2e.generatePrdLocked') : undefined}
              className={cn(
                'rounded-b-none border-b-2 border-transparent',
                source === tab.source && 'border-[var(--fill-accent)] text-[var(--text-primary)]',
              )}
              onClick={() => setSource(tab.source)}
            >
              {tab.label}
            </Button>
          ))}
        </div>
        {source === 'saved' && (
          <E2eSavedCasePicker apiClient={apiClient} value={saved} onChange={setSaved} />
        )}
        {source === 'prd' && (
          <div className="flex flex-col gap-3" data-testid="e2e-generate-prd">
            <p className="text-sm text-[var(--text-secondary)]">{t('e2e.generatePrdHint')}</p>
            <div
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              data-testid="e2e-generate-dropzone"
            >
              <Button
                variant="ghost"
                isLoading={reading}
                className={cn(
                  'flex h-auto w-full flex-col gap-1 rounded-lg border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] py-5 font-normal',
                  dragging && 'border-[var(--fill-accent)]',
                )}
                onClick={() => fileInput.current?.click()}
              >
                <i
                  className="ti ti-folder-open text-3xl text-[var(--text-muted)]"
                  aria-hidden="true"
                />
                <span className="text-sm text-[var(--text-primary)]">{t('e2e.prdSelect')}</span>
                <span className="text-xs text-[var(--text-muted)]">
                  {t('e2e.generatePrdFormats')}
                </span>
              </Button>
            </div>
            <Input
              ref={fileInput}
              type="file"
              multiple
              accept={PRD_ACCEPT}
              className="hidden"
              data-testid="e2e-generate-file-input"
              onChange={onFilesChange}
            />
            {fileError && (
              <p className="text-xs text-red-400" role="alert">
                {fileError}
              </p>
            )}
            {files.length > 0 && (
              <ul className="flex flex-col gap-1.5" aria-label={t('e2e.uploadedFiles')}>
                {files.map((file) => (
                  <li
                    key={file.name}
                    className="flex items-center gap-2 rounded-md border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-primary)]"
                  >
                    <i className="ti ti-file-text text-[var(--text-muted)]" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{file.name}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t('e2e.removeFile', { name: file.name })}
                      onClick={() => setFiles(files.filter((item) => item.name !== file.name))}
                    >
                      <i className="ti ti-x" aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-col gap-1.5">
              <span className="text-sm text-[var(--text-secondary)]">
                {t('e2e.generatePrdTextLabel')}
              </span>
              <MarkdownEditor
                scope="e2e"
                value={text}
                onChange={setText}
                placeholder={t('e2e.generatePrdPlaceholder')}
                testId="e2e-generate-editor"
              />
            </div>
          </div>
        )}
        {error && (
          <p className="text-sm text-red-400" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close} disabled={submitting}>
            {t('e2e.cancel')}
          </Button>
          {source === 'saved' && (
            <Button
              variant="secondary"
              onClick={() => void submit(true)}
              disabled={!ready || submitting}
            >
              <i className="ti ti-link" aria-hidden="true" />
              {t('e2e.linkOnlySubmit')}
            </Button>
          )}
          <Button onClick={() => void submit()} disabled={!ready || reading} isLoading={submitting}>
            <i className="ti ti-wand" aria-hidden="true" />
            {t('e2e.generateSubmit')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
