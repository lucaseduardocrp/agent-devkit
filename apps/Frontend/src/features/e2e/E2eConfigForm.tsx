import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
} from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../lib/i18n/index.js';
import { usePermissions } from '../workspaces/permissions.js';
import type { TranslationKey } from '../../lib/i18n/types.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Select } from '../../components/ui/select.js';
import { SkeletonCard } from '../../components/ui/skeleton.js';
import { Textarea } from '../../components/ui/textarea.js';
import type { CustomAgentDto } from '../agents/agent-types.js';
import {
  isQuickTunnelUrl,
  suggestedScriptFolder,
  type E2eCreationDetail,
  type E2eCreationInput,
  type E2eCreationSummary,
  type E2eExecutionTarget,
  type E2eMode,
  type E2eRepositoryProvider,
  type E2eScope,
  type TestManagementProviderId,
} from './e2e-types.js';
import { E2eRepositoryPicker, type E2eRepositorySelection } from './E2eRepositoryPicker.js';
import {
  E2eCasePicker,
  EMPTY_SELECTION,
  type TestManagementSelection,
} from './E2eTestManagement.js';
import {
  E2eSavedCasePicker,
  EMPTY_SAVED_SELECTION,
  savedSelectionReady,
  type SavedCaseSelection,
} from './E2eSavedCasePicker.js';
import { AdkCliInstall } from './AdkCliInstall.js';
import { E2eLocalRunnerPanel } from './E2eLocalRunnerPanel.js';
import {
  LocalHelperError,
  localTunnelBridge,
  type LocalHelperErrorCode,
} from './local-tunnel-bridge.js';

const PRD_ACCEPT = '.md,.markdown,.txt,.json,.yaml,.yml,.html,.htm,.csv,.xml,.feature';
const DIFF_ACCEPT = '.diff,.patch,.txt';
const MAX_FILE_BYTES = 2_000_000;

interface UploadedFile {
  readonly name: string;
  readonly content: string;
}

/** Tests are planned from a PRD, automate platform cases or automate cases saved in ADK. */
type TestSource = 'prd' | 'cases' | 'saved';

/** Saved cases a run starts from, e.g. when opened from Test Plans. */
export interface E2eSavedCasesSeed {
  readonly suiteId?: string;
  readonly planId?: string;
  readonly caseIds?: readonly string[];
}

interface FormState {
  readonly source: TestSource;
  readonly cases: TestManagementSelection;
  readonly saved: SavedCaseSelection;
  readonly mode: E2eMode;
  readonly scope: E2eScope;
  readonly name: string;
  readonly agentId: string;
  readonly username: string;
  readonly password: string;
  readonly accessClientId: string;
  readonly accessClientSecret: string;
  readonly clearAccessServiceToken: boolean;
  readonly baseUrl: string;
  readonly localOrigin: string;
  /** `local` runs the browser on the user's computer through `devkit runner`. */
  readonly executionTarget: E2eExecutionTarget;
  readonly path: string;
  readonly files: readonly UploadedFile[];
  readonly prdText: string;
  readonly diff: string;
  readonly instructions: string;
  readonly repository: E2eRepositorySelection;
  /** Until edited, the scripts folder follows the run name. */
  readonly pathTouched: boolean;
}

type FieldError =
  | 'name'
  | 'agentId'
  | 'baseUrl'
  | 'localOrigin'
  | 'access'
  | 'prd'
  | 'diff'
  | 'repository'
  | 'cases'
  | 'saved';

const tunnelCheckMessage: Record<
  'ok' | 'authentication' | 'origin_error' | 'network_error' | 'host_error' | 'request_error',
  TranslationKey
> = {
  ok: 'e2e.tunnelCheckOk',
  authentication: 'e2e.tunnelCheckAuthentication',
  origin_error: 'e2e.tunnelCheckOrigin',
  network_error: 'e2e.tunnelCheckNetwork',
  host_error: 'e2e.tunnelCheckHost',
  request_error: 'e2e.tunnelCheckRequest',
};

const localHelperMessage: Record<LocalHelperErrorCode, TranslationKey> = {
  unreachable: 'e2e.localHelperUnreachable',
  origin_mismatch: 'e2e.localHelperOriginMismatch',
  outdated: 'e2e.localHelperOutdated',
  failed: 'e2e.localHelperFailed',
};

const initialState = (agentId = '', seed?: E2eSavedCasesSeed): FormState => ({
  source: seed ? 'saved' : 'prd',
  cases: EMPTY_SELECTION,
  saved: seed
    ? {
        suiteId: seed.suiteId ?? '',
        planId: seed.planId ?? '',
        caseIds: seed.caseIds?.length ? seed.caseIds : null,
      }
    : EMPTY_SAVED_SELECTION,
  mode: 'frontend',
  scope: 'codebase',
  name: '',
  agentId,
  username: '',
  password: '',
  accessClientId: '',
  accessClientSecret: '',
  clearAccessServiceToken: false,
  baseUrl: 'http://localhost:3000',
  localOrigin: '',
  executionTarget: 'remote',
  path: '',
  files: [],
  prdText: '',
  diff: '',
  instructions: '',
  repository: { provider: '', id: '', branch: '', path: 'tests/e2e' },
  pathTouched: false,
});

/** Form values of an existing run; its documents come back as one pasted PRD. */
const stateFromCreation = (creation: E2eCreationDetail): FormState => ({
  source: 'prd',
  cases: EMPTY_SELECTION,
  saved: EMPTY_SAVED_SELECTION,
  mode: creation.mode,
  scope: creation.scope,
  name: creation.name,
  agentId: creation.agentId,
  username: creation.username ?? '',
  password: '',
  accessClientId: '',
  accessClientSecret: '',
  clearAccessServiceToken: false,
  baseUrl: creation.baseUrl,
  localOrigin: creation.localOrigin ?? '',
  executionTarget: creation.executionTarget ?? 'remote',
  path: creation.path.replace(/^\/+/, ''),
  files: [],
  prdText: creation.prd,
  diff: creation.diff ?? '',
  instructions: creation.instructions ?? '',
  repository: creation.repository
    ? {
        provider: creation.repository.provider,
        id: creation.repository.id,
        branch: creation.repository.branch,
        path: creation.repository.path,
      }
    : { ...initialState().repository, path: suggestedScriptFolder(creation.name) },
  pathTouched: true,
});

function defaultAgentId(agents: readonly CustomAgentDto[]): string {
  return (agents.find((agent) => agent.role === 'QA') ?? agents[0])?.id ?? '';
}

function isHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value.trim()).protocol);
  } catch {
    return false;
  }
}

function localAppOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase()) &&
      !url.username &&
      !url.password
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function isLocalBrowserOrigin(value: string): boolean {
  if (!localAppOrigin(value)) return false;
  const url = new URL(value.trim());
  return url.pathname === '/' && !url.search && !url.hash;
}

function quickTunnelCommand(origin: string): string {
  return `cloudflared tunnel --url ${origin} --http-host-header ${new URL(origin).host}`;
}

export interface E2eConfigFormProps {
  readonly apiClient: ApiClient;
  /** Edits this run instead of creating a new one. */
  readonly creationId?: string;
  /** Called with the run once it is created or, when editing, saved. */
  readonly onCreated: (creation: E2eCreationSummary) => void;
  readonly onCancel: () => void;
  readonly onOpenAgents?: () => void;
  readonly onOpenIntegrations?: () => void;
  /** Starts a new run from these saved test cases. */
  readonly initialSavedCases?: E2eSavedCasesSeed;
}

export function E2eConfigForm({
  apiClient,
  creationId,
  initialSavedCases,
  onCreated,
  onCancel,
  onOpenAgents,
  onOpenIntegrations,
}: E2eConfigFormProps) {
  const { t } = useI18n();
  // Automating platform cases imports them from test plans.
  const canImportCases = usePermissions().can('testplans');
  const [agents, setAgents] = useState<readonly CustomAgentDto[] | null>(null);
  const [form, setForm] = useState<FormState>(() => initialState('', initialSavedCases));
  const [editing, setEditing] = useState<E2eCreationDetail | null>(null);
  const [editLoadError, setEditLoadError] = useState<string | null>(null);
  const [errors, setErrors] = useState<ReadonlySet<FieldError>>(new Set());
  const [fileError, setFileError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [tunnelCheck, setTunnelCheck] = useState<{
    url: string;
    reason:
      'ok' | 'authentication' | 'origin_error' | 'network_error' | 'host_error' | 'request_error';
    status: number | null;
  } | null>(null);
  const [checkingTunnel, setCheckingTunnel] = useState(false);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [startingLocalTunnel, setStartingLocalTunnel] = useState(false);
  const [localTunnelError, setLocalTunnelError] = useState<{
    code: LocalHelperErrorCode;
    detail: string;
  } | null>(null);
  const [showTunnelSetup, setShowTunnelSetup] = useState(false);
  const [showAccessSettings, setShowAccessSettings] = useState(false);
  const [dragging, setDragging] = useState(false);
  const prdInput = useRef<HTMLInputElement>(null);
  const diffInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void apiClient
      .getAgents()
      .catch(() => [] as readonly CustomAgentDto[])
      .then((list) => {
        if (!active) return;
        setAgents(list);
        setForm((current) => ({ ...current, agentId: current.agentId || defaultAgentId(list) }));
      });
    return () => {
      active = false;
    };
  }, [apiClient]);

  const loadEditing = useCallback(() => {
    if (!creationId) return () => undefined;
    let active = true;
    setEditLoadError(null);
    apiClient
      .getE2eCreation(creationId)
      .then((creation) => {
        if (!active) return;
        setEditing(creation);
        setForm(stateFromCreation(creation));
        if (creation.hasAccessServiceToken) setShowAccessSettings(true);
      })
      .catch((error: unknown) => {
        if (active)
          setEditLoadError(error instanceof Error ? error.message : t('e2e.editLoadFailed'));
      });
    return () => {
      active = false;
    };
  }, [apiClient, creationId, t]);
  useEffect(loadEditing, [loadEditing]);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    if (key === 'baseUrl' || key === 'executionTarget') {
      setTunnelCheck(null);
      setCopyStatus('idle');
      setLocalTunnelError(null);
    }
    if (
      key === 'accessClientId' ||
      key === 'accessClientSecret' ||
      key === 'clearAccessServiceToken'
    )
      setTunnelCheck(null);
    setForm((current) => ({
      ...current,
      [key]: value,
      ...(key === 'baseUrl' &&
      current.mode === 'frontend' &&
      current.executionTarget === 'remote' &&
      localAppOrigin(value as string)
        ? { localOrigin: localAppOrigin(value as string)! }
        : {}),
      // A local runner opens the app directly: a tunnel's localhost origin becomes the target.
      ...(key === 'executionTarget' && value === 'local'
        ? {
            baseUrl: localAppOrigin(current.localOrigin) ?? current.baseUrl,
            localOrigin: '',
            accessClientId: '',
            accessClientSecret: '',
          }
        : {}),
      ...(key === 'mode' && value === 'backend' ? { localOrigin: '' } : {}),
      ...((key === 'accessClientId' || key === 'accessClientSecret') && value
        ? { clearAccessServiceToken: false }
        : {}),
      ...(key === 'name' && !current.pathTouched
        ? {
            repository: {
              ...current.repository,
              path: suggestedScriptFolder(value as string),
            },
          }
        : {}),
    }));
    setErrors((current) => {
      const next = new Set(current);
      next.delete(key === 'files' || key === 'prdText' ? 'prd' : (key as FieldError));
      if (key === 'accessClientId' || key === 'accessClientSecret') next.delete('access');
      // Switching the source changes which of the two is required.
      if (key === 'source') next.delete('prd');
      return next;
    });
  };

  const copyTunnelCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  };

  const checkTunnel = async (
    value?: string,
    credentials = { clientId: form.accessClientId, clientSecret: form.accessClientSecret },
  ) => {
    if (Boolean(credentials.clientId.trim()) !== Boolean(credentials.clientSecret.trim())) {
      setErrors((current) => new Set(current).add('access'));
      setShowAccessSettings(true);
      return;
    }
    const url = value ?? form.baseUrl.trim();
    setCheckingTunnel(true);
    setTunnelCheck(null);
    try {
      const result = await apiClient.checkE2eTunnel(url, {
        ...(creationId ? { creationId } : {}),
        ...(credentials.clientId.trim() ? { accessClientId: credentials.clientId.trim() } : {}),
        ...(credentials.clientSecret.trim()
          ? { accessClientSecret: credentials.clientSecret.trim() }
          : {}),
      });
      setTunnelCheck({ url, reason: result.reason, status: result.status });
    } catch {
      setTunnelCheck({ url, reason: 'request_error', status: null });
    } finally {
      setCheckingTunnel(false);
    }
  };

  const startLocalTunnel = async () => {
    // The action is only offered when one of the two is a localhost address.
    const origin = (localAppOrigin(form.localOrigin) ?? localAppOrigin(form.baseUrl))!;
    setStartingLocalTunnel(true);
    setLocalTunnelError(null);
    try {
      const result = await localTunnelBridge.start(origin);
      if (!result.tunnel) throw new LocalHelperError('failed', 'Tunnel did not start.');
      const { accessClientId, accessClientSecret, publicUrl } = result.tunnel;
      if (!accessClientId || !accessClientSecret) {
        await localTunnelBridge.stop().catch(() => undefined);
        throw new LocalHelperError('outdated', 'The local helper cannot route local services.');
      }
      if (form.mode === 'frontend') update('localOrigin', origin);
      update('accessClientId', accessClientId);
      update('accessClientSecret', accessClientSecret);
      update('baseUrl', publicUrl);
      await checkTunnel(publicUrl, { clientId: accessClientId, clientSecret: accessClientSecret });
    } catch (error) {
      let failure =
        error instanceof LocalHelperError ? error : new LocalHelperError('failed', String(error));
      // The browser hides why the POST preflight failed; a simple GET can reveal a wrong --origin.
      if (failure.code === 'unreachable') {
        failure = await localTunnelBridge.status().then(
          () => failure,
          (reason: unknown) =>
            reason instanceof LocalHelperError && reason.code === 'origin_mismatch'
              ? reason
              : failure,
        );
      }
      setLocalTunnelError({ code: failure.code, detail: failure.message });
      setShowTunnelSetup(true);
    } finally {
      setStartingLocalTunnel(false);
    }
  };

  const localHelperAlert = localTunnelError && (
    <div role="alert" className="space-y-1 text-xs text-amber-400">
      <p>{t(localHelperMessage[localTunnelError.code])}</p>
      {localTunnelError.code === 'failed' && (
        <p className="break-words font-mono">{localTunnelError.detail}</p>
      )}
      {localTunnelError.code === 'origin_mismatch' && (
        <code className="block select-all break-all rounded bg-[var(--surface-1)] p-2 font-mono text-[var(--text-primary)]">
          {`devkit bridge --origin ${window.location.origin}`}
        </code>
      )}
    </div>
  );

  const commandBlock = (command: string, copyable = false) => (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <code className="min-w-0 flex-1 select-all break-all rounded bg-[var(--surface-1)] p-2 font-mono text-[var(--text-primary)]">
        {command}
      </code>
      {copyable && (
        <Button variant="outline" size="sm" onClick={() => void copyTunnelCommand(command)}>
          {t('e2e.copyTunnelCommand')}
        </Button>
      )}
    </div>
  );

  const tunnelSetup = (origin: string) => (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={showTunnelSetup}
        aria-controls={showTunnelSetup ? 'e2e-tunnel-setup' : undefined}
        onClick={() => setShowTunnelSetup((current) => !current)}
        className="h-auto w-full justify-start whitespace-normal border-t border-[var(--border)] px-0 pt-3 text-left text-xs text-[var(--text-accent)] hover:underline"
      >
        <i className="ti ti-terminal-2" aria-hidden="true" />
        {t('e2e.tunnelSetupOptions')}
        <i
          className={cn('ti ml-auto', showTunnelSetup ? 'ti-chevron-up' : 'ti-chevron-down')}
          aria-hidden="true"
        />
      </Button>
      {showTunnelSetup && (
        <div id="e2e-tunnel-setup" className="space-y-3 text-xs text-[var(--text-secondary)]">
          <AdkCliInstall />
          <div className="border-t border-[var(--border)] pt-3">
            <p>{t('e2e.localHelperSetup')}</p>
            {commandBlock(`devkit bridge --origin ${window.location.origin}`)}
          </div>
          <div className="border-t border-[var(--border)] pt-3">
            <p className="font-medium text-[var(--text-primary)]">{t('e2e.terminalTunnelHint')}</p>
            {commandBlock(`devkit tunnel --url ${origin}`, true)}
            <p className="mt-2">{t('e2e.terminalTunnelPaste')}</p>
          </div>
          <div className="border-t border-[var(--border)] pt-3">
            <p className="font-medium text-[var(--text-primary)]">{t('e2e.manualTunnelHint')}</p>
            {commandBlock(quickTunnelCommand(origin))}
          </div>
          <a
            href="https://developers.cloudflare.com/tunnel/downloads/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-[var(--text-accent)] underline underline-offset-2"
          >
            {t('e2e.installCloudflared')}
          </a>
          {copyStatus !== 'idle' && (
            <p role="status">
              {t(
                copyStatus === 'copied' ? 'e2e.tunnelCommandCopied' : 'e2e.tunnelCommandCopyFailed',
              )}
            </p>
          )}
          <p>{t('e2e.localhostPaste')}</p>
          <p>{t('e2e.localhostExposure')}</p>
        </div>
      )}
    </>
  );

  const setRepository = useCallback((repository: E2eRepositorySelection) => {
    setForm((current) => ({ ...current, repository }));
    setErrors((current) => {
      const next = new Set(current);
      next.delete('repository');
      return next;
    });
  }, []);

  const setScriptPath = (path: string) =>
    setForm((current) => ({
      ...current,
      pathTouched: true,
      repository: { ...current.repository, path },
    }));

  const readFiles = async (list: FileList | null): Promise<UploadedFile[]> => {
    const read: UploadedFile[] = [];
    for (const file of Array.from(list ?? [])) {
      try {
        if (file.size > MAX_FILE_BYTES) throw new Error('too large');
        read.push({ name: file.name, content: await file.text() });
      } catch {
        setFileError(t('e2e.fileReadFailed', { name: file.name }));
      }
    }
    return read;
  };

  const addPrdFiles = async (list: FileList | null) => {
    setFileError(null);
    const read = await readFiles(list);
    if (!read.length) return;
    setForm((current) => ({
      ...current,
      files: [
        ...current.files.filter((file) => !read.some((item) => item.name === file.name)),
        ...read,
      ],
    }));
    setErrors((current) => {
      const next = new Set(current);
      next.delete('prd');
      return next;
    });
  };

  const onPrdChange = (event: ChangeEvent<HTMLInputElement>) => {
    void addPrdFiles(event.target.files);
    event.target.value = '';
  };

  const onDiffChange = async (event: ChangeEvent<HTMLInputElement>) => {
    setFileError(null);
    const [file] = await readFiles(event.target.files);
    event.target.value = '';
    if (file) update('diff', file.content);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void addPrdFiles(event.dataTransfer.files);
  };

  const prdContent = () =>
    [...form.files.map((file) => `# ${file.name}\n\n${file.content}`), form.prdText.trim()]
      .filter(Boolean)
      .join('\n\n---\n\n');

  const validate = (): Set<FieldError> => {
    const next = new Set<FieldError>();
    if (!form.name.trim()) next.add('name');
    if (!form.agentId) next.add('agentId');
    // Only a runner on the user's computer can open localhost addresses.
    if (
      !isHttpUrl(form.baseUrl) ||
      (form.executionTarget === 'remote' && localAppOrigin(form.baseUrl))
    )
      next.add('baseUrl');
    if (
      form.executionTarget === 'remote' &&
      form.localOrigin.trim() &&
      (!isLocalBrowserOrigin(form.localOrigin) || form.mode !== 'frontend')
    )
      next.add('localOrigin');
    if (Boolean(form.accessClientId.trim()) !== Boolean(form.accessClientSecret.trim()))
      next.add('access');
    if (form.source === 'prd' && !prdContent().trim()) next.add('prd');
    if (form.source === 'cases' && form.cases.caseIds.length === 0) next.add('cases');
    if (form.source === 'saved' && !savedSelectionReady(form.saved)) next.add('saved');
    if (form.scope === 'diff' && !form.diff.trim()) next.add('diff');
    if (!form.repository.provider || !form.repository.id || !form.repository.branch)
      next.add('repository');
    return next;
  };

  const submit = async () => {
    const invalid = validate();
    setErrors(invalid);
    if (invalid.has('access')) setShowAccessSettings(true);
    setSubmitError(null);
    if (invalid.size) return;
    setSubmitting(true);
    // The pasted PRD of an edited run already holds its earlier files' content.
    const fileNames = [...(editing?.prdFileNames ?? []), ...form.files.map((file) => file.name)];
    try {
      const input: E2eCreationInput = {
        name: form.name.trim(),
        agentId: form.agentId,
        mode: form.mode,
        scope: form.scope,
        baseUrl: form.baseUrl.trim(),
        localOrigin: form.executionTarget === 'local' ? '' : form.localOrigin.trim(),
        executionTarget: form.executionTarget,
        path: form.path.trim(),
        ...(form.username.trim() ? { username: form.username.trim() } : {}),
        ...(form.password ? { password: form.password } : {}),
        ...(form.accessClientId.trim() ? { accessClientId: form.accessClientId.trim() } : {}),
        ...(form.accessClientSecret.trim()
          ? { accessClientSecret: form.accessClientSecret.trim() }
          : {}),
        ...(form.clearAccessServiceToken ? { clearAccessServiceToken: true } : {}),
        prd: prdContent(),
        prdFileNames: [...new Set(fileNames)],
        ...(form.source === 'cases' ? { importCases: importCases(form.cases) } : {}),
        ...(form.source === 'saved' ? { savedCases: savedCases(form.saved) } : {}),
        ...(form.scope === 'diff' ? { diff: form.diff } : {}),
        ...(form.instructions.trim() ? { instructions: form.instructions.trim() } : {}),
        repository: {
          provider: form.repository.provider as E2eRepositoryProvider,
          id: form.repository.id,
          branch: form.repository.branch,
          path: form.repository.path.trim(),
        },
      };
      onCreated(
        editing
          ? await apiClient.updateE2eCreation(editing.id, input)
          : await apiClient.createE2eCreation(input),
      );
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : t(editing ? 'e2e.saveFailed' : 'e2e.createFailed'),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    setForm(
      editing
        ? stateFromCreation(editing)
        : initialState(defaultAgentId(agents ?? []), initialSavedCases),
    );
    setErrors(new Set());
    setFileError(null);
    setSubmitError(null);
    setTunnelCheck(null);
    setShowTunnelSetup(false);
    setShowAccessSettings(Boolean(editing?.hasAccessServiceToken));
  };

  const fieldError = (field: FieldError, message: TranslationKey) =>
    errors.has(field) ? (
      <p className="mt-1.5 text-xs text-red-400" role="alert">
        {t(message)}
      </p>
    ) : null;

  const header = (
    <div className="flex flex-col gap-3">
      <Button variant="ghost" size="sm" className="w-fit" onClick={onCancel}>
        <i className="ti ti-arrow-left" aria-hidden="true" />
        {t('e2e.back')}
      </Button>
      <h2 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">
        {t(creationId ? 'e2e.editTitle' : 'e2e.configTitle')}
      </h2>
    </div>
  );

  if (creationId && !editing)
    return (
      <div
        className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6"
        data-testid="e2e-config-form"
      >
        {header}
        {editLoadError ? (
          <div className="flex flex-col items-start gap-3" role="alert">
            <p className="text-sm text-red-400">{editLoadError}</p>
            <Button variant="outline" size="sm" onClick={() => void loadEditing()}>
              {t('e2e.retry')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4" aria-busy="true">
            <SkeletonCard />
            <SkeletonCard />
          </div>
        )}
      </div>
    );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6" data-testid="e2e-config-form">
      {header}

      <Section title={t('e2e.testingTypes')} hint={t('e2e.testingTypesHint')} required>
        <Row label={t('e2e.mode')} hint={t('e2e.modeHint')}>
          <Segmented
            label={t('e2e.mode')}
            value={form.mode}
            options={[
              { value: 'backend', label: t('e2e.typeBackend') },
              { value: 'frontend', label: t('e2e.typeFrontend') },
            ]}
            onChange={(value) => update('mode', value)}
          />
        </Row>
        <Row label={t('e2e.scope')} hint={t('e2e.scopeHint')}>
          <Segmented
            label={t('e2e.scope')}
            value={form.scope}
            options={[
              { value: 'codebase', label: t('e2e.scopeCodebase') },
              { value: 'diff', label: t('e2e.scopeDiff') },
            ]}
            onChange={(value) => update('scope', value)}
          />
        </Row>
        {form.scope === 'diff' && (
          <Row label={t('e2e.diffLabel')}>
            <Textarea
              aria-label={t('e2e.diffLabel')}
              value={form.diff}
              onChange={(event) => update('diff', event.target.value)}
              placeholder={t('e2e.diffPlaceholder')}
              rows={6}
              className="font-mono text-xs"
            />
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => diffInput.current?.click()}
            >
              <i className="ti ti-upload" aria-hidden="true" />
              {t('e2e.diffUpload')}
            </Button>
            <Input
              ref={diffInput}
              type="file"
              accept={DIFF_ACCEPT}
              className="hidden"
              data-testid="e2e-diff-input"
              onChange={(event) => void onDiffChange(event)}
            />
            {fieldError('diff', 'e2e.validationDiff')}
          </Row>
        )}
      </Section>

      <Section title={t('e2e.runDetails')} required>
        <Row label={t('e2e.runName')}>
          <Input
            aria-label={t('e2e.runName')}
            value={form.name}
            onChange={(event) => update('name', event.target.value)}
            placeholder={t('e2e.runNamePlaceholder')}
            variant={errors.has('name') ? 'error' : 'default'}
          />
          {fieldError('name', 'e2e.validationName')}
        </Row>
        <Row label={t('e2e.agent')} hint={t('e2e.agentHint')}>
          {agents && agents.length === 0 ? (
            <p className="text-sm text-amber-400">
              {t('e2e.noAgents')}{' '}
              {onOpenAgents && (
                <Button variant="link" size="sm" className="h-auto p-0" onClick={onOpenAgents}>
                  {t('nav.agents')}
                </Button>
              )}
            </p>
          ) : (
            <Select
              aria-label={t('e2e.agent')}
              value={form.agentId}
              onChange={(event) => update('agentId', event.target.value)}
              disabled={!agents}
            >
              {(agents ?? []).map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </Select>
          )}
          {fieldError('agentId', 'e2e.validationAgent')}
        </Row>
      </Section>

      <Section title={t('e2e.repositoryTitle')} hint={t('e2e.repositoryHint')} required>
        <E2eRepositoryPicker
          apiClient={apiClient}
          value={form.repository}
          invalid={errors.has('repository')}
          onChange={setRepository}
          onPathChange={setScriptPath}
          onOpenIntegrations={onOpenIntegrations}
        />
      </Section>

      <Section title={t('e2e.accountTitle')} badge={t('e2e.optional')} hint={t('e2e.accountHint')}>
        <Row label={t('e2e.username')} hint={t('e2e.usernameHint')}>
          <Input
            aria-label={t('e2e.username')}
            value={form.username}
            autoComplete="off"
            onChange={(event) => update('username', event.target.value)}
          />
        </Row>
        <Row
          label={t('e2e.password')}
          hint={
            editing?.hasPassword
              ? `${t('e2e.passwordHint')} ${t('e2e.passwordKeep')}`
              : t('e2e.passwordHint')
          }
        >
          <Input
            aria-label={t('e2e.password')}
            type="password"
            placeholder={editing?.hasPassword ? '••••••••' : undefined}
            value={form.password}
            autoComplete="new-password"
            onChange={(event) => update('password', event.target.value)}
          />
        </Row>
      </Section>

      <Section title={t('e2e.targetTitle')} hint={t('e2e.targetHint')} required>
        <div className="space-y-2">
          <Segmented
            label={t('e2e.executionTitle')}
            value={form.executionTarget}
            options={[
              { value: 'remote', label: t('e2e.executionRemote') },
              { value: 'local', label: t('e2e.executionLocal') },
            ]}
            onChange={(value) => update('executionTarget', value)}
          />
          <p className="text-xs text-[var(--text-muted)]">
            {t(
              form.executionTarget === 'local'
                ? 'e2e.executionLocalHint'
                : 'e2e.executionRemoteHint',
            )}
          </p>
        </div>

        <div className="space-y-2">
          <label
            htmlFor="e2e-base-url"
            className="block text-sm font-medium text-[var(--text-primary)]"
          >
            {t('e2e.baseUrl')}
          </label>
          <Input
            id="e2e-base-url"
            aria-label={t('e2e.baseUrl')}
            value={form.baseUrl}
            onChange={(event) => update('baseUrl', event.target.value)}
            variant={errors.has('baseUrl') ? 'error' : 'default'}
            inputMode="url"
            autoComplete="url"
          />
          {fieldError(
            'baseUrl',
            localAppOrigin(form.baseUrl) ? 'e2e.validationReachableUrl' : 'e2e.validationUrl',
          )}
          <p className="text-xs text-[var(--text-muted)]">
            {t(
              form.executionTarget === 'local'
                ? 'e2e.localRunnerUrlHint'
                : localAppOrigin(form.baseUrl)
                  ? 'e2e.localUrlHint'
                  : 'e2e.publicUrlHint',
            )}
          </p>
        </div>

        {form.executionTarget === 'local' ? (
          <E2eLocalRunnerPanel apiClient={apiClient} {...(creationId ? { creationId } : {})} />
        ) : localAppOrigin(form.baseUrl) ? (
          <div className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-[var(--surface-1)] p-3">
              <p className="min-w-0 flex-1 text-xs text-[var(--text-secondary)]">
                {t('e2e.useLocalRunnerHint')}
              </p>
              <Button size="sm" onClick={() => update('executionTarget', 'local')}>
                {t('e2e.useLocalRunner')}
              </Button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-semibold text-[var(--text-primary)]">
                  {t('e2e.localConnectionTitle')}
                </p>
                <p className="text-xs text-[var(--text-secondary)]">{t('e2e.localhostHint')}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                isLoading={startingLocalTunnel}
                onClick={() => void startLocalTunnel()}
              >
                {t('e2e.startLocalTunnel')}
              </Button>
            </div>
            {localHelperAlert}
            {tunnelSetup(localAppOrigin(form.baseUrl)!)}
          </div>
        ) : (
          isHttpUrl(form.baseUrl) &&
          form.baseUrl.trim().startsWith('https://') && (
            <div className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-[var(--text-primary)]">
                    {t('e2e.connectionCheckTitle')}
                  </p>
                  <p className="text-xs text-[var(--text-secondary)]">
                    {t('e2e.connectionCheckHint')}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {form.mode === 'frontend' && isLocalBrowserOrigin(form.localOrigin) && (
                    <Button
                      size="sm"
                      isLoading={startingLocalTunnel}
                      onClick={() => void startLocalTunnel()}
                    >
                      {t('e2e.startLocalTunnel')}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    isLoading={checkingTunnel}
                    onClick={() => void checkTunnel()}
                  >
                    {t('e2e.checkTunnel')}
                  </Button>
                </div>
              </div>
              {localHelperAlert}
              {form.mode === 'frontend' &&
                isLocalBrowserOrigin(form.localOrigin) &&
                tunnelSetup(localAppOrigin(form.localOrigin)!)}
              {tunnelCheck?.url === form.baseUrl.trim() && (
                <p
                  role="status"
                  className={cn(
                    'flex items-start gap-2 rounded-md px-3 py-2 text-xs',
                    tunnelCheck.reason === 'ok'
                      ? 'bg-green-500/10 text-green-400'
                      : 'bg-amber-500/10 text-amber-400',
                  )}
                >
                  <i
                    className={cn(
                      'ti mt-0.5',
                      tunnelCheck.reason === 'ok' ? 'ti-circle-check' : 'ti-alert-circle',
                    )}
                    aria-hidden="true"
                  />
                  {t(tunnelCheckMessage[tunnelCheck.reason] ?? 'e2e.tunnelCheckRequest')}
                </p>
              )}
              {form.accessClientId.trim().startsWith('adk-local-') && (
                <p className="flex items-start gap-2 text-xs text-[var(--text-secondary)]">
                  <i className="ti ti-route mt-0.5" aria-hidden="true" />
                  {t('e2e.localGatewayActive')}
                </p>
              )}
              {form.mode === 'frontend' && (
                <div className="space-y-2 border-t border-[var(--border)] pt-3">
                  <label
                    htmlFor="e2e-local-origin"
                    className="block text-xs font-medium text-[var(--text-primary)]"
                  >
                    {t('e2e.browserOriginLabel')}
                  </label>
                  <Input
                    id="e2e-local-origin"
                    aria-label={t('e2e.browserOriginLabel')}
                    value={form.localOrigin}
                    onChange={(event) => update('localOrigin', event.target.value)}
                    variant={errors.has('localOrigin') ? 'error' : 'default'}
                    placeholder="http://localhost:8014"
                    inputMode="url"
                  />
                  {fieldError('localOrigin', 'e2e.validationBrowserOrigin')}
                  <p className="text-xs text-[var(--text-secondary)]">
                    {t('e2e.browserOriginHint')}
                  </p>
                  {!form.localOrigin.trim() && isQuickTunnelUrl(form.baseUrl) && (
                    <p role="status" className="text-xs text-amber-400">
                      {t('e2e.tunnelOriginRecommended')}
                    </p>
                  )}
                </div>
              )}
            </div>
          )
        )}

        <div className="space-y-2">
          <label
            htmlFor="e2e-path"
            className="block text-sm font-medium text-[var(--text-primary)]"
          >
            {t('e2e.path')}
          </label>
          <Input
            id="e2e-path"
            aria-label={t('e2e.path')}
            value={form.path}
            onChange={(event) => update('path', event.target.value)}
            leftIcon={<span className="text-sm text-[var(--text-muted)]">/</span>}
          />
          <p className="text-xs text-[var(--text-muted)]">{t('e2e.pathHint')}</p>
        </div>

        {form.executionTarget === 'remote' && (
          <div className="border-t border-[var(--border)] pt-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={showAccessSettings}
              aria-controls={showAccessSettings ? 'e2e-access-settings' : undefined}
              onClick={() => setShowAccessSettings((current) => !current)}
              className="h-auto w-full justify-start whitespace-normal px-0 text-left text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              <i className="ti ti-lock" aria-hidden="true" />
              {t('e2e.accessSettingsTitle')}
              {editing?.hasAccessServiceToken && !form.clearAccessServiceToken && (
                <span className="rounded bg-[var(--surface-2)] px-2 py-0.5 text-xs">
                  {t('e2e.accessTokenSaved')}
                </span>
              )}
              <i
                className={cn(
                  'ti ml-auto',
                  showAccessSettings ? 'ti-chevron-up' : 'ti-chevron-down',
                )}
                aria-hidden="true"
              />
            </Button>
            {showAccessSettings && (
              <div
                id="e2e-access-settings"
                className="mt-3 space-y-2 text-sm text-[var(--text-secondary)]"
              >
                <p className="text-xs">{t('e2e.accessServiceTokenHint')}</p>
                <Input
                  aria-label={t('e2e.accessClientId')}
                  placeholder={t('e2e.accessClientId')}
                  value={form.accessClientId}
                  onChange={(event) => update('accessClientId', event.target.value)}
                />
                <Input
                  aria-label={t('e2e.accessClientSecret')}
                  placeholder={
                    editing?.hasAccessServiceToken ? '••••••••' : t('e2e.accessClientSecret')
                  }
                  type="password"
                  autoComplete="new-password"
                  value={form.accessClientSecret}
                  onChange={(event) => update('accessClientSecret', event.target.value)}
                />
                {fieldError('access', 'e2e.validationAccessToken')}
                {editing?.hasAccessServiceToken && !form.clearAccessServiceToken && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => update('clearAccessServiceToken', true)}
                  >
                    {t('e2e.removeAccessServiceToken')}
                  </Button>
                )}
                {form.clearAccessServiceToken && (
                  <p role="status">{t('e2e.accessServiceTokenRemoved')}</p>
                )}
              </div>
            )}
          </div>
        )}

        <p className="flex items-center gap-2 rounded-md bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--text-secondary)]">
          <i className="ti ti-info-circle-filled" aria-hidden="true" />
          {t('e2e.reachableWarning')}
        </p>
      </Section>

      {!creationId && canImportCases && (
        <Section title={t('e2e.sourceTitle')} hint={t('e2e.sourceHint')} required>
          <Select
            aria-label={t('e2e.sourceTitle')}
            value={form.source}
            onChange={(event) => update('source', event.target.value as typeof form.source)}
          >
            <option value="prd">{t('e2e.sourcePrd')}</option>
            <option value="cases">{t('e2e.sourceCases')}</option>
            <option value="saved">{t('e2e.sourceSaved')}</option>
          </Select>
          {form.source === 'cases' && (
            <E2eCasePicker
              apiClient={apiClient}
              value={form.cases}
              invalid={errors.has('cases')}
              onChange={(cases) => update('cases', cases)}
              onOpenIntegrations={onOpenIntegrations}
            />
          )}
          {form.source === 'saved' && (
            <E2eSavedCasePicker
              apiClient={apiClient}
              value={form.saved}
              invalid={errors.has('saved')}
              onChange={(saved) => update('saved', saved)}
            />
          )}
          {fieldError('saved', 'e2e.validationSaved')}
        </Section>
      )}

      {form.source === 'prd' && (
        <Section title={t('e2e.prdTitle')} hint={t('e2e.prdHint')} required>
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          data-testid="e2e-prd-dropzone"
        >
          <Button
            variant="ghost"
            className={cn(
              'flex h-auto w-full flex-col gap-2 rounded-lg border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] py-8 font-normal',
              dragging && 'border-[var(--fill-accent)]',
              errors.has('prd') && 'border-red-500/60',
            )}
            onClick={() => prdInput.current?.click()}
          >
            <i className="ti ti-folder-open text-4xl text-[var(--text-muted)]" aria-hidden="true" />
            <span className="text-sm text-[var(--text-primary)]">{t('e2e.prdSelect')}</span>
            <span className="text-xs text-[var(--text-muted)]">{t('e2e.prdFormats')}</span>
          </Button>
        </div>
        <Input
          ref={prdInput}
          type="file"
          multiple
          accept={PRD_ACCEPT}
          className="hidden"
          data-testid="e2e-prd-input"
          onChange={onPrdChange}
        />
        <p className="text-sm text-[var(--text-secondary)]">{t('e2e.prdDraftHint')}</p>
        {fileError && (
          <p className="text-xs text-red-400" role="alert">
            {fileError}
          </p>
        )}
        {form.files.length > 0 && (
          <div className="flex flex-col gap-2">
            <h4 className="text-sm font-semibold text-[var(--text-primary)]">
              {t('e2e.uploadedFiles')}
            </h4>
            <ul className="flex flex-col gap-1.5">
              {form.files.map((file) => (
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
                    onClick={() =>
                      update(
                        'files',
                        form.files.filter((item) => item.name !== file.name),
                      )
                    }
                  >
                    <i className="ti ti-x" aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <Row label={t('e2e.prdPaste')}>
          <Textarea
            aria-label={t('e2e.prdPaste')}
            value={form.prdText}
            onChange={(event) => update('prdText', event.target.value)}
            placeholder={t('e2e.prdPlaceholder')}
            rows={6}
          />
        </Row>
        {fieldError('prd', 'e2e.validationPrd')}
        </Section>
      )}

      <Section title={t('e2e.instructionsTitle')} badge={t('e2e.optional')}>
        <Textarea
          aria-label={t('e2e.instructionsTitle')}
          value={form.instructions}
          onChange={(event) => update('instructions', event.target.value)}
          placeholder={t('e2e.instructionsPlaceholder')}
          rows={3}
        />
      </Section>

      {submitError && (
        <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300" role="alert">
          {submitError}
        </p>
      )}

      <div className="flex justify-end gap-3">
        <Button variant="secondary" onClick={reset} disabled={submitting}>
          {t('e2e.reset')}
        </Button>
        <Button onClick={() => void submit()} isLoading={submitting} disabled={submitting}>
          {t(editing ? 'e2e.save' : 'e2e.continue')}
        </Button>
      </div>
    </div>
  );
}

/** Cases to import, as the API expects them; the picker only allows complete selections. */
function importCases(cases: TestManagementSelection) {
  return {
    provider: cases.provider as TestManagementProviderId,
    planId: cases.planId,
    ...(cases.suiteId ? { suiteId: cases.suiteId } : {}),
    caseIds: cases.caseIds,
  };
}

/** Saved cases to automate, as the API expects them. */
function savedCases(saved: SavedCaseSelection) {
  return {
    ...(saved.planId ? { planId: saved.planId } : { suiteId: saved.suiteId }),
    ...(saved.caseIds ? { caseIds: saved.caseIds } : {}),
  };
}

function Section({
  title,
  hint,
  badge,
  required = false,
  children,
}: {
  readonly title: string;
  readonly hint?: string;
  readonly badge?: string;
  readonly required?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-base font-semibold text-[var(--text-primary)]">
          {title}
          {required && (
            <span className="ml-1 text-red-400" aria-hidden="true">
              *
            </span>
          )}
          {badge && <span className="ml-1 font-normal text-[var(--text-muted)]">{badge}</span>}
        </h3>
        {hint && <p className="mt-0.5 text-sm text-[var(--text-secondary)]">{hint}</p>}
      </div>
      <div className="flex flex-col gap-4 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4">
        {children}
      </div>
    </section>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-[160px_1fr] sm:gap-4">
      <span className="pt-2 text-sm text-[var(--text-secondary)]">{label}</span>
      <div className="min-w-0">
        {children}
        {hint && <p className="mt-1.5 text-xs text-[var(--text-muted)]">{hint}</p>}
      </div>
    </div>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onChange: (value: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="grid grid-cols-2 gap-1 rounded-md border border-[var(--border)] bg-[var(--surface-0)] p-1"
    >
      {options.map((option) => (
        <Button
          key={option.value}
          role="radio"
          aria-checked={option.value === value}
          variant={option.value === value ? 'secondary' : 'ghost'}
          size="sm"
          className="h-9"
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}
