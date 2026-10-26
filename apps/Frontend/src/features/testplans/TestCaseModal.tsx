import { useRef, useState, type ReactNode } from 'react';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Modal } from '../../components/ui/modal.js';
import { useI18n } from '../../lib/i18n/index.js';
import { sanitizeRichText, testCaseFields, testCaseOrigin } from './test-case-fields.js';
import type { TestCase } from './TestPlansView.js';
import { AttachmentPanel } from '../shared/AttachmentPanel.js';
import type { Attachment } from '../shared/attachment-types.js';
import {
  discardDrafts,
  editorHtml,
  saveWithDrafts,
  useInlineImages,
  useMediaClient,
  useRichTextImageInput,
} from '../shared/media.js';

/** Files of the case; kept in its metadata, which the test plan stores as is. */
function caseAttachments(metadata: Record<string, unknown> | undefined): Attachment[] {
  const value = metadata?.['attachments'];
  return Array.isArray(value)
    ? value.filter(
        (item): item is Attachment =>
          Boolean(item) &&
          typeof item === 'object' &&
          typeof (item as Attachment).id === 'string' &&
          typeof (item as Attachment).url === 'string',
      )
    : [];
}

export interface TestCaseModalProps {
  readonly testCase: TestCase;
  /** Hides every editing control; set when the member cannot edit test plans. */
  readonly readOnly?: boolean;
  /** Title of the Test Plan that holds the case. */
  readonly planTitle?: string;
  /** History button of the case, when it has been saved. */
  readonly history?: ReactNode;
  readonly isSaving?: boolean;
  readonly onSave: (testCase: TestCase) => void;
  readonly onClose: () => void;
  /** Opens a new E2E run that automates this case. */
  readonly onAutomate?: () => void;
}

const copy = {
  'pt-BR': {
    testCase: 'Caso de teste',
    plan: 'Test Plan',
    steps: 'Passos',
    origin: 'Origem',
    createdInAdk: 'Criado no ADK',
    remoteId: 'ID no provedor',
    remotePlan: 'Plano',
    remoteSuite: 'Suíte',
    importedAt: 'Importado em',
    openOnPlatform: 'Abrir no provedor',
    providerFields: 'Campos do provedor',
    providerFieldsHint: 'Trazidos de {provider}. Importe de novo para atualizar.',
    noProviderFields: 'Este caso não tem campos do provedor.',
    automate: 'Automatizar com E2E',
    close: 'Fechar',
  },
  'en-US': {
    testCase: 'Test case',
    plan: 'Test Plan',
    steps: 'Steps',
    origin: 'Origin',
    createdInAdk: 'Created in ADK',
    remoteId: 'Provider ID',
    remotePlan: 'Plan',
    remoteSuite: 'Suite',
    importedAt: 'Imported on',
    openOnPlatform: 'Open on the provider',
    providerFields: 'Provider fields',
    providerFieldsHint: 'Brought from {provider}. Import again to refresh them.',
    noProviderFields: 'This case has no provider fields.',
    automate: 'Automate with E2E',
    close: 'Close',
  },
} as const;

const RICH_TEXT =
  'text-sm leading-6 text-[var(--text-primary)] [&_h1]:my-3 [&_h1]:text-lg [&_h1]:font-bold [&_h2]:my-3 [&_h2]:font-bold [&_h3]:my-2 [&_h3]:font-semibold [&_li]:my-1 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6';

/**
 * A single test case in its own window, like PBIs and issues: title and actions on top,
 * description and steps on the left, and on the right where the case came from with every
 * field its test management platform keeps for it.
 */
export function TestCaseModal({
  testCase,
  readOnly = false,
  planTitle,
  history,
  isSaving = false,
  onSave,
  onClose,
  onAutomate,
}: TestCaseModalProps) {
  const { t, locale, formatDate } = useI18n();
  const c = copy[locale];
  const [draft, setDraft] = useState<TestCase>(testCase);
  const editor = useRef<HTMLDivElement>(null);
  const origin = testCaseOrigin(testCase.metadata);
  const fields = origin ? testCaseFields(testCase.metadata, origin.provider) : [];
  const steps = draft.steps ?? [];
  const setSteps = (next: TestCase['steps']) => setDraft({ ...draft, steps: next });
  const content = useRef<HTMLDivElement>(null);
  // The editor and the platform fields show images by their stored address.
  useInlineImages(content, testCase);
  const scenarioImages = useRichTextImageInput('testcase', editor, (html) =>
    setDraft((current) => ({ ...current, scenario: sanitizeRichText(html) })),
  );
  const attachments = caseAttachments(draft.metadata);
  const apiClient = useMediaClient();
  const [committing, setCommitting] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  // Closing without saving drops what was pasted and attached to the case.
  const close = () => {
    discardDrafts(draft);
    onClose();
  };
  /** Pasted and attached files are drafts until the case is saved, which uploads them. */
  const save = async () => {
    if (!apiClient) {
      onSave(draft);
      return;
    }
    setCommitting(true);
    setFileError(null);
    try {
      await saveWithDrafts(
        apiClient,
        'testcase',
        { scenario: draft.scenario, metadata: draft.metadata },
        (files) => Promise.resolve(onSave({ ...draft, ...files })),
      );
    } catch (reason) {
      setFileError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCommitting(false);
    }
  };

  const format = (command: string, value?: string) => {
    // The toolbar is rendered right above the editor, so the editor is mounted.
    const node = editor.current!;
    node.focus();
    if (value === undefined) document.execCommand(command, false);
    else document.execCommand(command, false, value);
    setDraft({ ...draft, scenario: sanitizeRichText(editorHtml(node)) });
  };

  return (
    <Modal open onClose={close} labelledBy="edit-testcase-title">
      <div
        className="flex h-[min(90vh,900px)] w-[min(96vw,1400px)] flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)]"
        data-testid="test-case-modal"
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-3 text-xs text-[var(--text-accent)]">
          <span className="flex min-w-0 items-center gap-2">
            <i className="ti ti-test-pipe" aria-hidden="true" />
            <span className="truncate">
              {c.testCase} · {testCase.id}
              {origin && ` · ${origin.providerName} #${origin.caseId}`}
            </span>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('testplans.closeModal')}
            onClick={close}
          >
            <i className="ti ti-x" aria-hidden="true" />
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] px-6 py-4">
          <h2 id="edit-testcase-title" className="sr-only">
            {t('testplans.editCase', { id: testCase.id })}
          </h2>
          <Input
            value={draft.title}
            disabled={readOnly}
            maxLength={300}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            aria-label={t('testplans.caseTitleLabel')}
            data-testid="input-edit-test-title"
            className="min-w-[220px] flex-1 border-0 bg-transparent px-0 text-xl font-semibold shadow-none"
          />
          {history}
          {onAutomate && (
            <Button type="button" variant="outline" onClick={onAutomate}>
              <i className="ti ti-player-play" aria-hidden="true" />
              {c.automate}
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={close}>
            {readOnly ? c.close : t('common.cancel')}
          </Button>
          {!readOnly && (
            <Button
              type="button"
              onClick={() => void save()}
              disabled={!draft.title.trim()}
              isLoading={isSaving || committing}
              data-testid="btn-save-test-case-modal"
            >
              <i className="ti ti-device-floppy" aria-hidden="true" />
              {t('testplans.saveCase')}
            </Button>
          )}
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-2 border-b border-[var(--border)] bg-[var(--surface-2)] px-6 py-3 text-xs">
          {planTitle && (
            <span>
              {c.plan} <strong className="ml-1 text-[var(--text-accent)]">{planTitle}</strong>
            </span>
          )}
          <span>
            {c.steps} <strong className="ml-1 text-[var(--text-accent)]">{steps.length}</strong>
          </span>
          <span>
            {c.origin}{' '}
            <strong className="ml-1 text-[var(--text-accent)]">
              {origin ? origin.providerName : c.createdInAdk}
            </strong>
          </span>
        </div>

        <div
          ref={content}
          className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)] [&_img]:my-2 [&_img]:max-w-full [&_img]:rounded"
        >
          <div className="space-y-6 p-6 lg:border-r lg:border-[var(--border)]">
            <section>
              <h3 className="mb-3 border-b border-[var(--border)] pb-3 text-sm font-semibold">
                <i className="ti ti-align-left mr-2 text-[var(--text-accent)]" aria-hidden="true" />
                {t('testplans.caseScenarioLabel')}
              </h3>
              <div className="overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface-2)]">
                {!readOnly && (
                  <div className="flex flex-wrap items-center gap-1 border-b border-[var(--border)] p-1.5">
                    {(
                      [
                        ['bold', 'ti-bold', t('testplans.toolbarBold')],
                        ['italic', 'ti-italic', t('testplans.toolbarItalic')],
                        ['underline', 'ti-underline', t('testplans.toolbarUnderline')],
                        ['insertUnorderedList', 'ti-list', t('testplans.toolbarList')],
                      ] as const
                    ).map(([command, icon, label]) => (
                      <button
                        key={command}
                        type="button"
                        className="flex h-8 w-8 items-center justify-center rounded text-muted hover:bg-surface-1 hover:text-[var(--text-primary)]"
                        aria-label={label}
                        title={label}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => format(command)}
                      >
                        <i className={`ti ${icon}`} aria-hidden="true" />
                      </button>
                    ))}
                    <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
                    <button
                      type="button"
                      className="flex h-8 items-center gap-1 rounded px-2 text-xs text-muted hover:bg-surface-1 hover:text-[var(--text-primary)]"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => format('formatBlock', 'h3')}
                      aria-label={t('testplans.toolbarHeading')}
                    >
                      <i className="ti ti-heading" aria-hidden="true" /> H
                    </button>
                  </div>
                )}
                <div
                  ref={editor}
                  contentEditable={!readOnly}
                  suppressContentEditableWarning
                  role="textbox"
                  aria-multiline="true"
                  aria-readonly={readOnly}
                  aria-label={t('testplans.caseScenarioLabel')}
                  data-testid="input-edit-test-scenario"
                  className={`min-h-56 overflow-x-auto whitespace-pre-wrap p-4 outline-none ${RICH_TEXT}`}
                  dangerouslySetInnerHTML={{ __html: sanitizeRichText(testCase.scenario) }}
                  onInput={(event) =>
                    setDraft({
                      ...draft,
                      scenario: sanitizeRichText(editorHtml(event.currentTarget)),
                    })
                  }
                  onPaste={readOnly ? undefined : scenarioImages.onPaste}
                  onDrop={readOnly ? undefined : scenarioImages.onDrop}
                />
              </div>
            </section>

            <section>
              <div className="mb-3 flex items-center justify-between border-b border-[var(--border)] pb-3">
                <h3 className="text-sm font-semibold">
                  <i
                    className="ti ti-list-numbers mr-2 text-[var(--text-accent)]"
                    aria-hidden="true"
                  />
                  {t('testplans.testSteps')}
                </h3>
                {!readOnly && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setSteps([
                        ...steps,
                        { order: steps.length + 1, action: '', expectedResult: '' },
                      ])
                    }
                    leftIcon={<i className="ti ti-plus text-xs" aria-hidden="true" />}
                    data-testid="btn-add-step"
                  >
                    {t('testplans.addStep')}
                  </Button>
                )}
              </div>
              <ol className="space-y-2">
                {steps.map((step, index) => (
                  <li
                    key={index}
                    className="flex gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 text-xs"
                  >
                    <div className="min-w-0 flex-1 space-y-2">
                      <label className="block space-y-1 font-medium text-[var(--text-muted)]">
                        <span>{t('testplans.stepActionField')}</span>
                        <Input
                          placeholder={t('testplans.stepActionPlaceholder')}
                          value={step.action}
                          disabled={readOnly}
                          onChange={(event) =>
                            setSteps(
                              steps.map((item, i) =>
                                i === index ? { ...item, action: event.target.value } : item,
                              ),
                            )
                          }
                          aria-label={t('testplans.stepActionLabel', { number: index + 1 })}
                          data-testid={`input-step-action-${index + 1}`}
                        />
                      </label>
                      <label className="block space-y-1 font-medium text-[var(--text-muted)]">
                        <span>{t('testplans.stepExpectedField')}</span>
                        <Input
                          placeholder={t('testplans.stepExpectedPlaceholder')}
                          value={step.expectedResult}
                          disabled={readOnly}
                          onChange={(event) =>
                            setSteps(
                              steps.map((item, i) =>
                                i === index
                                  ? { ...item, expectedResult: event.target.value }
                                  : item,
                              ),
                            )
                          }
                          aria-label={t('testplans.stepExpectedLabel', { number: index + 1 })}
                          data-testid={`input-step-expected-${index + 1}`}
                        />
                      </label>
                    </div>
                    {!readOnly && (
                      <button
                        type="button"
                        onClick={() => setSteps(steps.filter((_, i) => i !== index))}
                        className="self-start text-red-400 hover:text-red-300"
                        title={t('testplans.removeStep', { number: index + 1 })}
                        aria-label={t('testplans.removeStep', { number: index + 1 })}
                      >
                        <i className="ti ti-trash text-sm" aria-hidden="true" />
                      </button>
                    )}
                  </li>
                ))}
              </ol>
            </section>

            <AttachmentPanel
              scope="testcase"
              attachments={attachments}
              disabled={readOnly}
              onChange={(next) =>
                setDraft({ ...draft, metadata: { ...(draft.metadata ?? {}), attachments: next } })
              }
              onInsertInline={scenarioImages.insertAttachment}
            />
            {(fileError ?? scenarioImages.error) && (
              <p role="alert" className="text-xs text-red-300">
                {fileError ?? scenarioImages.error}
              </p>
            )}
          </div>

          <aside className="space-y-5 bg-[var(--surface-1)] p-6">
            <section className="space-y-3" aria-label={c.origin}>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                {c.origin}
              </h3>
              {origin ? (
                <dl className="space-y-2 text-xs">
                  <Row label={c.origin} value={origin.providerName} />
                  <Row label={c.remoteId} value={origin.caseId} />
                  {origin.planId && <Row label={c.remotePlan} value={origin.planId} />}
                  {origin.suiteId && <Row label={c.remoteSuite} value={origin.suiteId} />}
                  {origin.importedAt && (
                    <Row label={c.importedAt} value={formatDate(origin.importedAt)} />
                  )}
                </dl>
              ) : (
                <p className="text-xs text-[var(--text-muted)]">{c.createdInAdk}</p>
              )}
              {origin?.url && (
                <a
                  href={origin.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-[var(--text-accent)] underline"
                >
                  <i className="ti ti-external-link" aria-hidden="true" />
                  {c.openOnPlatform}
                </a>
              )}
            </section>

            {origin && (
              <section className="space-y-3" aria-label={c.providerFields}>
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    {c.providerFields}
                  </h3>
                  <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                    {c.providerFieldsHint.replace('{provider}', origin.providerName)}
                  </p>
                </div>
                {fields.length ? (
                  <dl className="space-y-3" data-testid="test-case-provider-fields">
                    {fields.map((field) => (
                      <div key={field.key} className="min-w-0">
                        <dt className="text-[11px] font-semibold text-[var(--text-secondary)]">
                          {field.label}
                        </dt>
                        {field.html ? (
                          <dd
                            className={`mt-0.5 break-words ${RICH_TEXT}`}
                            dangerouslySetInnerHTML={{ __html: sanitizeRichText(field.value) }}
                          />
                        ) : (
                          <dd className="mt-0.5 break-words text-sm text-[var(--text-primary)]">
                            {field.value}
                          </dd>
                        )}
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p className="text-xs text-[var(--text-muted)]">{c.noProviderFields}</p>
                )}
              </section>
            )}
          </aside>
        </div>
      </div>
    </Modal>
  );
}

function Row({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-[var(--text-muted)]">{label}</dt>
      <dd className="min-w-0 break-words text-right text-[var(--text-primary)]">{value}</dd>
    </div>
  );
}
