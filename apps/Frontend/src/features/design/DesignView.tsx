import { useEffect, useMemo, useState } from 'react';
import { ResizableSidebar } from '../../components/layout/ResizableSidebar.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Select } from '../../components/ui/select.js';
import { Textarea } from '../../components/ui/textarea.js';
import { Toast } from '../../components/ui/toast.js';
import { ConfirmationDialog } from '../../components/ui/confirmation-dialog.js';
import { ModeSwitch } from '../../components/ui/mode-switch.js';
import { useActivityRunner } from '../activities/ActivityCenter.js';
import { useI18n } from '../../lib/i18n/index.js';
import { usePermissions } from '../workspaces/permissions.js';
import type {
  ApiClient,
  DesignFileDto,
  DesignImageInput,
  DesignProjectDto,
  DesignSystemDto,
} from '../../lib/api-client.js';
import type { CustomAgentDto } from '../agents/agent-types.js';

export interface DesignViewProps {
  readonly apiClient: ApiClient;
  readonly activeWorkspaceId: string | null;
  readonly isReadOnly?: boolean;
  readonly onManageRepositories?: () => void;
}
type ToastState = { message: string; variant: 'success' | 'error' };
type DesignImage = DesignImageInput & { readonly name: string; readonly preview: string };
const acceptedImageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const maxImageBytes = 5 * 1024 * 1024;

function readImage(file: File): Promise<DesignImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read image.'));
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Unable to read image.'));
        return;
      }
      const preview = reader.result;
      resolve({
        name: file.name,
        mimeType: file.type as DesignImage['mimeType'],
        data: preview.slice(preview.indexOf(',') + 1),
        preview,
      });
    };
    reader.readAsDataURL(file);
  });
}

function previewDocument(files: readonly DesignFileDto[], emptyPreview: string): string {
  const html =
    files.find((file) => file.name.toLowerCase() === 'index.html')?.content ??
    `<main>${emptyPreview}</main>`;
  const stylesheets = files.filter((file) => file.name.toLowerCase().endsWith('.css'));
  const scripts = files.filter((file) => file.name.toLowerCase().endsWith('.js'));
  const scriptByPath = new Map(
    scripts.map((file) => [file.name.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase(), file]),
  );
  const findScript = (reference: string): DesignFileDto | undefined => {
    const path = reference
      .split(/[?#]/, 1)[0]!
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .toLowerCase();
    return (
      scriptByPath.get(path) ??
      scripts.find((candidate) =>
        candidate.name.replace(/\\/g, '/').toLowerCase().endsWith(`/${path}`),
      ) ??
      scripts.find(
        (candidate) =>
          candidate.name.split(/[\\/]/).at(-1)?.toLowerCase() === path.split('/').at(-1),
      )
    );
  };
  const stylesheetByPath = new Map(
    stylesheets.map((file) => [
      file.name.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase(),
      file,
    ]),
  );
  const inlineStylesheet = (reference: string): string | undefined => {
    const path = reference
      .split(/[?#]/, 1)[0]!
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .toLowerCase();
    const file =
      stylesheetByPath.get(path) ??
      stylesheets.find((candidate) =>
        candidate.name.replace(/\\/g, '/').toLowerCase().endsWith(`/${path}`),
      ) ??
      stylesheets.find(
        (candidate) =>
          candidate.name.split(/[\\/]/).at(-1)?.toLowerCase() === path.split('/').at(-1),
      );
    return file ? `<style>\n${file.content}\n</style>` : undefined;
  };
  const withLocalStylesheets = html.replace(
    /<link\b(?=[^>]*\brel=["']stylesheet["'])[^>]*>/gi,
    (tag) => {
      const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
      if (!href || /^(?:[a-z]+:|\/\/|#)/i.test(href)) return tag;
      return inlineStylesheet(href) ?? '';
    },
  );
  const referencedScripts = new Set<string>();
  const withLocalScripts = withLocalStylesheets.replace(
    /<script\b([^>]*\bsrc=["']([^"']+\.js(?:[?#][^"']*)?)["'][^>]*)><\/script>/gi,
    (tag, attributes: string, reference: string) => {
      if (/^(?:[a-z]+:|\/\/|#)/i.test(reference)) return tag;
      const file = findScript(reference);
      if (!file) return tag;
      referencedScripts.add(file.name);
      const inlineAttributes = attributes.replace(/\s+src=["'][^"']+["']/i, '');
      return `<script${inlineAttributes}>\n${file.content}\n</script>`;
    },
  );
  const unreferencedStyles = stylesheets
    .filter((file) => !html.includes(file.name.split(/[\\/]/).at(-1)!))
    .map((file) => `<style>\n${file.content}\n</style>`)
    .join('\n');
  const unreferencedScripts = scripts
    .filter((file) => !referencedScripts.has(file.name))
    .map((file) => `<script>\n${file.content}\n</script>`)
    .join('\n');
  return withLocalScripts
    .replace('</head>', `${unreferencedStyles}</head>`)
    .replace('</body>', `${unreferencedScripts}</body>`);
}

function download(name: string, content: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function openHtmlPreview(content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/html' }));
  const previewWindow = window.open(url, '_blank', 'noopener,noreferrer');
  if (!previewWindow) URL.revokeObjectURL(url);
  else window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function DesignView({
  apiClient,
  activeWorkspaceId,
  isReadOnly = false,
  onManageRepositories,
}: DesignViewProps) {
  const { runActivity } = useActivityRunner();
  const { t } = useI18n();
  const { can } = usePermissions();
  // Delete includes edit, so a read-only member never gets it.
  const canDelete = !isReadOnly && can('design', 'delete');
  const canManageRepositories = can('integrations');
  const [projects, setProjects] = useState<readonly DesignProjectDto[]>([]);
  const [systems, setSystems] = useState<readonly DesignSystemDto[]>([]);
  const [designSystemId, setDesignSystemId] = useState('');
  const [systemName, setSystemName] = useState('');
  const [systemContent, setSystemContent] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [editingSystemId, setEditingSystemId] = useState<string>();
  const [section, setSection] = useState<'prototypes' | 'systems'>('prototypes');
  const [isGeneratingSystem, setIsGeneratingSystem] = useState(false);
  const [systemMode, setSystemMode] = useState<'preview' | 'code'>('preview');
  const [agents, setAgents] = useState<readonly CustomAgentDto[]>([]);
  const [providers, setProviders] = useState<readonly ('github' | 'azure')[]>([]);
  const [provider, setProvider] = useState<'github' | 'azure'>('github');
  const [selected, setSelected] = useState<DesignProjectDto | null>(null);
  const [selectedFile, setSelectedFile] = useState('index.html');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [prototypeImages, setPrototypeImages] = useState<readonly DesignImage[]>([]);
  const [systemImages, setSystemImages] = useState<readonly DesignImage[]>([]);
  const [agentId, setAgentId] = useState('');
  const [message, setMessage] = useState('');
  const [chatImages, setChatImages] = useState<readonly DesignImage[]>([]);
  const [mode, setMode] = useState<'preview' | 'code'>('preview');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DesignProjectDto | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    Promise.all([apiClient.getDesignProviders(), apiClient.getAgents()])
      .then(async ([nextProviders, nextAgents]) => {
        const projectResults = await Promise.allSettled(
          nextProviders.map((item) => apiClient.getDesignProjects(item)),
        );
        const primaryProvider = nextProviders[0];
        const systemsResult = primaryProvider
          ? await Promise.resolve(apiClient.getDesignSystems(primaryProvider)).then(
              (systems) => ({ status: 'fulfilled' as const, value: systems }),
              (reason: unknown) => ({ status: 'rejected' as const, reason }),
            )
          : null;
        if (!mounted) return;
        setProviders(nextProviders);
        setProvider(primaryProvider ?? 'github');
        setProjects(
          projectResults.flatMap((result) =>
            result.status === 'fulfilled' ? [...result.value] : [],
          ),
        );
        setAgents(nextAgents);
        setAgentId(nextAgents[0]?.id ?? '');
        if (systemsResult?.status === 'fulfilled') setSystems(systemsResult.value);
        const failedProjects = projectResults.filter((result) => result.status === 'rejected');
        if (failedProjects.length === projectResults.length && projectResults.length > 0) {
          const reason: unknown = failedProjects[0]?.reason;
          throw reason instanceof Error ? reason : new Error(t('design.loadProjectsFailed'));
        }
      })
      .catch(
        (error: unknown) =>
          mounted &&
          setToast({
            message: error instanceof Error ? error.message : t('design.loadFailed'),
            variant: 'error',
          }),
      )
      .finally(() => mounted && setLoading(false));
    return () => {
      mounted = false;
    };
  }, [apiClient, activeWorkspaceId, t]);

  const activeFile =
    selected?.files.find((file) => file.name === selectedFile) ?? selected?.files[0];
  const srcDoc = useMemo(
    () => previewDocument(selected?.files ?? [], t('design.noPreview')),
    [selected?.files, t],
  );
  const openProject = (project: DesignProjectDto) => {
    setSection('prototypes');
    setSelected(project);
    const projectAgent = agents.find((agent) => agent.id === project.agentId);
    setAgentId(projectAgent?.id ?? agents[0]?.id ?? '');
    setSelectedFile(project.files[0]?.name ?? 'index.html');
  };
  const replaceProject = (project: DesignProjectDto) => {
    setSelected(project);
    setProjects((all) => [
      project,
      ...all.filter((item) => item.id !== project.id || item.provider !== project.provider),
    ]);
    setSelectedFile((current) =>
      project.files.some((file) => file.name === current)
        ? current
        : (project.files[0]?.name ?? 'index.html'),
    );
  };
  const imagePicker = (
    id: string,
    images: readonly DesignImage[],
    setImages: (images: readonly DesignImage[]) => void,
  ) => (
    <div className="rounded-lg border border-dashed border-border-strong bg-surface-2/60 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="block text-sm font-semibold text-[var(--text-primary)]">
            {t('runtime.referenceImages')}
          </span>
          <p className="mt-1 text-xs leading-5 text-muted">{t('runtime.imageHelp')}</p>
        </div>
        <label
          htmlFor={id}
          className="inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-md border border-border bg-surface-1 px-3 py-2 text-xs font-semibold text-[var(--text-primary)] transition-colors hover:border-border-accent hover:bg-surface-2"
        >
          <i className="ti ti-photo-plus" aria-hidden="true" />
          {t('runtime.addImages')}
        </label>
        <input
          id={id}
          className="sr-only"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = '';
            if (images.length + files.length > 4) {
              setToast({ message: t('runtime.imageLimit'), variant: 'error' });
              return;
            }
            if (
              files.some((file) => !acceptedImageTypes.has(file.type) || file.size > maxImageBytes)
            ) {
              setToast({ message: t('runtime.invalidImage'), variant: 'error' });
              return;
            }
            void Promise.all(files.map(readImage)).then((next) => setImages([...images, ...next]));
          }}
        />
      </div>
      {images.length > 0 ? (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid={`${id}-previews`}>
          {images.map((image, index) => (
            <div
              key={`${image.name}:${index}`}
              className="group relative aspect-[4/3] overflow-hidden rounded-md border border-border bg-surface-1"
            >
              <img src={image.preview} alt={image.name} className="h-full w-full object-cover" />
              <button
                type="button"
                className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-md bg-black/75 text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                aria-label={t('runtime.removeImage', { name: image.name })}
                onClick={() => setImages(images.filter((_, itemIndex) => itemIndex !== index))}
              >
                <i className="ti ti-x" aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <label
          htmlFor={id}
          className="mt-3 flex min-h-20 cursor-pointer items-center justify-center rounded-md border border-border bg-surface-1/50 px-4 py-3 text-center text-xs text-muted transition-colors hover:border-border-accent hover:bg-surface-1"
        >
          <span className="flex items-center gap-2">
            <i className="ti ti-upload" aria-hidden="true" />
            {t('runtime.addImages')}
          </span>
        </label>
      )}
    </div>
  );
  const create = async () => {
    setPending(true);
    try {
      const project = await runActivity(
        { kind: 'agent', title: t('design.creatingPrototype', { title: title.trim() }) },
        () =>
          apiClient.createDesignProject({
            title: title.trim(),
            prompt: prompt.trim(),
            ...(designSystemId ? { designSystemId } : {}),
            agentId,
            provider,
            ...(prototypeImages.length
              ? { images: prototypeImages.map(({ mimeType, data }) => ({ mimeType, data })) }
              : {}),
          }),
      );
      replaceProject(project);
      setPrompt('');
      setPrototypeImages([]);
      setToast({ message: t('design.prototypeCreated'), variant: 'success' });
    } catch (error) {
      setToast({
        message: error instanceof Error ? error.message : t('design.createFailed'),
        variant: 'error',
      });
    } finally {
      setPending(false);
    }
  };
  const chat = async (selected: DesignProjectDto) => {
    const content = message.trim() || t('design.imageMessage');
    setPending(true);
    try {
      const project = await runActivity(
        { kind: 'agent', title: t('design.updatingPrototype', { title: selected.title }) },
        () =>
          apiClient.chatDesignProject(
            selected.id,
            content,
            selected.provider,
            agentId,
            chatImages.map(({ mimeType, data }) => ({ mimeType, data })),
          ),
      );
      replaceProject(project);
      setMessage('');
      setChatImages([]);
      setToast({ message: t('design.prototypeUpdated'), variant: 'success' });
    } catch (error) {
      setToast({
        message: error instanceof Error ? error.message : t('design.updateFailed'),
        variant: 'error',
      });
    } finally {
      setPending(false);
    }
  };
  const addChatImages = (files: readonly File[]) => {
    if (chatImages.length + files.length > 4) {
      setToast({ message: t('runtime.imageLimit'), variant: 'error' });
      return;
    }
    if (files.some((file) => !acceptedImageTypes.has(file.type) || file.size > maxImageBytes)) {
      setToast({ message: t('runtime.invalidImage'), variant: 'error' });
      return;
    }
    void Promise.all(files.map(readImage)).then((next) => setChatImages([...chatImages, ...next]));
  };
  const updateCode = (content: string) =>
    selected &&
    setSelected({
      ...selected,
      files: selected.files.map((file) =>
        file.name === activeFile?.name ? { ...file, content } : file,
      ),
    });
  const saveCode = async (selected: DesignProjectDto) => {
    setPending(true);
    try {
      replaceProject(
        await runActivity(
          { kind: 'push', title: t('design.savingCode', { title: selected.title }) },
          () => apiClient.updateDesignFiles(selected.id, selected.files, selected.provider),
        ),
      );
      setToast({ message: t('design.codeSaved'), variant: 'success' });
    } catch (error) {
      setToast({
        message: error instanceof Error ? error.message : t('design.saveCodeFailed'),
        variant: 'error',
      });
    } finally {
      setPending(false);
    }
  };
  const pullProject = async (selected: DesignProjectDto) => {
    setPending(true);
    try {
      replaceProject(
        await runActivity(
          { kind: 'pull', title: t('design.pullingPrototype', { title: selected.title }) },
          () => apiClient.getDesignProject(selected.id, selected.provider),
        ),
      );
      setToast({ message: t('design.repositoryVersionLoaded'), variant: 'success' });
    } catch (error) {
      setToast({
        message: error instanceof Error ? error.message : t('design.pullFailed'),
        variant: 'error',
      });
    } finally {
      setPending(false);
    }
  };
  const saveSystem = async () => {
    setPending(true);
    try {
      const saved = await runActivity(
        { kind: 'push', title: t('design.savingSystem', { name: systemName.trim() }) },
        () =>
          apiClient.saveDesignSystem(provider, {
            id: editingSystemId,
            name: systemName.trim(),
            content: systemContent.trim(),
          }),
      );
      setSystems((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      setDesignSystemId(saved.id);
      setSystemName('');
      setSystemContent('');
      setToast({ message: t('design.systemSaved'), variant: 'success' });
    } catch (error) {
      setToast({
        message: error instanceof Error ? error.message : t('design.saveSystemFailed'),
        variant: 'error',
      });
    } finally {
      setPending(false);
    }
  };
  const generateSystem = async () => {
    setPending(true);
    setIsGeneratingSystem(true);
    try {
      const result = await runActivity({ kind: 'agent', title: t('design.generatingSystem') }, () =>
        apiClient.generateDesignSystem(
          agentId,
          systemPrompt.trim(),
          systemImages.map(({ mimeType, data }) => ({ mimeType, data })),
        ),
      );
      const name = systemName.trim() || systemPrompt.trim().slice(0, 80);
      const saved = await runActivity(
        { kind: 'push', title: t('design.savingSystem', { name }) },
        () =>
          apiClient.saveDesignSystem(provider, {
            id: editingSystemId,
            name,
            content: result.content,
          }),
      );
      setSystemContent(result.content);
      setSystemMode('preview');
      setSystemName(saved.name);
      setEditingSystemId(saved.id);
      setDesignSystemId(saved.id);
      setSystems((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      setSystemImages([]);
      setToast({ message: t('design.generatedAndSaved'), variant: 'success' });
    } catch (error) {
      setToast({
        message: error instanceof Error ? error.message : t('design.generateSystemFailed'),
        variant: 'error',
      });
    } finally {
      setIsGeneratingSystem(false);
      setPending(false);
    }
  };
  const deleteSystem = async (systemId: string) => {
    setPending(true);
    try {
      await apiClient.deleteDesignSystem(systemId, provider);
      setSystems((current) => current.filter((item) => item.id !== systemId));
      setEditingSystemId(undefined);
      setSystemName('');
      setSystemContent('');
      setToast({ message: t('design.systemDeleted'), variant: 'success' });
    } finally {
      setPending(false);
    }
  };
  const exportProject = (selected: DesignProjectDto) => {
    download(
      `${selected.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.html`,
      previewDocument(selected.files, t('design.noPreview')),
      'text/html',
    );
  };

  return (
    <div
      className="flex h-full min-h-0 w-full overflow-hidden bg-surface-0"
      data-testid="screen-design"
    >
      <ResizableSidebar
        aria-label={t('design.projects')}
        defaultWidth={280}
        minWidth={220}
        maxWidth="container"
        className="border-r border-border bg-surface-1"
      >
        <div className="flex min-h-0 flex-1 flex-col p-3">
          {!isReadOnly && (
            <Button
              className="mb-2 justify-start"
              variant={section === 'prototypes' && !selected ? 'secondary' : 'ghost'}
              onClick={() => {
                setSection('prototypes');
                setSelected(null);
                setTitle('');
                setPrompt('');
              }}
            >
              <i className="ti ti-plus" aria-hidden="true" /> {t('design.newPrototype')}
            </Button>
          )}
          <Button
            className="justify-start"
            variant={section === 'systems' ? 'secondary' : 'ghost'}
            onClick={() => {
              setSection('systems');
            }}
          >
            <i className="ti ti-palette" aria-hidden="true" /> Design Systems
          </Button>
          <p className="mb-2 mt-5 px-2 text-xs font-semibold uppercase tracking-wide text-muted">
            {t('design.savedProjects')}
          </p>
          <div className="thin-scrollbar min-h-0 flex-1 space-y-1 overflow-y-auto">
            {loading ? (
              <p className="px-2 text-sm text-muted">{t('common.loading')}</p>
            ) : projects.length === 0 ? (
              <p className="px-2 text-sm text-muted">{t('runtime.noDesignProjects')}</p>
            ) : (
              projects.map((project) => (
                <Button
                  key={`${project.provider}:${project.id}`}
                  variant={selected?.id === project.id ? 'secondary' : 'ghost'}
                  className="w-full justify-start truncate"
                  onClick={() => openProject(project)}
                >
                  <i className="ti ti-layout" aria-hidden="true" />
                  <span className="truncate">{project.title}</span>
                </Button>
              ))
            )}
          </div>
        </div>
      </ResizableSidebar>
      {section === 'systems' ? (
        <main className="min-w-0 flex-1 overflow-y-auto p-6">
          <section className="mx-auto max-w-5xl space-y-5">
            <header>
              <h1 className="text-xl font-semibold">{t('runtime.designSystems')}</h1>
              <p className="text-sm text-muted">{t('runtime.designSystemsDescription')}</p>
            </header>
            <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
              <aside className="space-y-1 rounded-xl border border-border bg-surface-1 p-3">
                {!isReadOnly && (
                  <Button
                    className="mb-2 w-full"
                    size="sm"
                    onClick={() => {
                      setEditingSystemId(undefined);
                      setSystemName('');
                      setSystemContent('');
                    }}
                  >
                    {t('design.newTemplate')}
                  </Button>
                )}
                {systems.map((system) => (
                  <Button
                    key={system.id}
                    className="w-full justify-start truncate"
                    variant={editingSystemId === system.id ? 'secondary' : 'ghost'}
                    onClick={() => {
                      setEditingSystemId(system.id);
                      setSystemName(system.name);
                      setSystemContent(system.content);
                    }}
                  >
                    {system.name}
                  </Button>
                ))}
              </aside>
              <div className="space-y-3 rounded-xl border border-border bg-surface-1 p-5">
                {!isReadOnly && (
                  <>
                    <Input
                      aria-label={t('design.systemName')}
                      value={systemName}
                      onChange={(event) => setSystemName(event.target.value)}
                      placeholder={t('design.templateName')}
                    />
                    <Textarea
                      aria-label={t('design.systemDescription')}
                      value={systemPrompt}
                      onChange={(event) => setSystemPrompt(event.target.value)}
                      className="min-h-24"
                      placeholder={t('design.systemDescriptionPlaceholder')}
                    />
                    <div>
                      <label
                        htmlFor="design-system-agent"
                        className="mb-1.5 block text-sm font-medium"
                      >
                        {t('design.agent')}
                      </label>
                      <Select
                        id="design-system-agent"
                        value={agentId}
                        onChange={(event) => setAgentId(event.target.value)}
                      >
                        <option value="">{t('runtime.selectAgent')}</option>
                        {agents.map((agent) => (
                          <option key={agent.id} value={agent.id}>
                            {agent.name}
                          </option>
                        ))}
                      </Select>
                    </div>
                    {imagePicker('design-system-images', systemImages, setSystemImages)}
                    <Button
                      variant="outline"
                      disabled={pending || !systemPrompt.trim() || !agentId}
                      isLoading={isGeneratingSystem}
                      onClick={() => void generateSystem()}
                    >
                      <i className="ti ti-sparkles" aria-hidden="true" /> {t('design.generateHtml')}
                    </Button>
                  </>
                )}
                <div className="flex justify-end">
                  <ModeSwitch
                    mode={systemMode}
                    onChange={setSystemMode}
                    ariaLabel={t('design.systemMode')}
                  />
                  {/*
                  <div
                    className="flex items-center gap-0.5 rounded-md border border-border bg-surface-2 p-0.5"
                    role="group"
                    aria-label="Modo do Design System"
                  >
                    <Button
                      size="icon"
                      variant={systemMode === 'preview' ? 'secondary' : 'ghost'}
                      className="h-7 w-7 rounded p-0 leading-none [&_i]:leading-none"
                      aria-label="Preview"
                      title="Preview"
                      onClick={() => setSystemMode('preview')}
                    >
                      <i className="ti ti-eye" aria-hidden="true" />
                    </Button>
                    <Button
                      size="icon"
                      variant={systemMode === 'code' ? 'secondary' : 'ghost'}
                      className="h-7 w-7 rounded p-0 leading-none [&_i]:leading-none"
                      aria-label={t('common.code')}
                      title={t('common.code')}
                      onClick={() => setSystemMode('code')}
                    >
                      <i className="ti ti-code" aria-hidden="true" />
                    </Button>
                  </div> */}
                </div>
                {systemMode === 'code' ? (
                  <Textarea
                    aria-label={t('design.systemContent')}
                    value={systemContent}
                    readOnly={isReadOnly}
                    onChange={(event) => setSystemContent(event.target.value)}
                    className="min-h-72 font-mono text-xs"
                    placeholder="<!doctype html>..."
                  />
                ) : (
                  <div className="overflow-hidden rounded-lg border border-border bg-white">
                    <div className="flex items-center justify-between border-b border-border bg-surface-2 px-3 py-2 text-xs font-medium text-muted">
                      <span>{t('runtime.visualPreview')}</span>
                      {systemContent && (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6"
                          aria-label={t('design.openPreview')}
                          title={t('design.openPreview')}
                          onClick={() => openHtmlPreview(systemContent)}
                        >
                          <i className="ti ti-external-link" aria-hidden="true" />
                        </Button>
                      )}
                    </div>
                    {isGeneratingSystem ? (
                      <div
                        className="flex h-[min(70vh,720px)] items-center justify-center gap-3 bg-surface-0 text-sm text-muted"
                        role="status"
                      >
                        <i
                          className="ti ti-loader-2 animate-spin text-lg text-accent-foreground"
                          aria-hidden="true"
                        />
                        {t('design.generatingAndSaving')}
                      </div>
                    ) : systemContent ? (
                      <iframe
                        title={t('design.systemPreview')}
                        sandbox="allow-scripts"
                        srcDoc={systemContent}
                        className="h-[min(70vh,720px)] w-full border-0 bg-white"
                      />
                    ) : (
                      <div className="flex h-[min(70vh,720px)] items-center justify-center bg-surface-0 text-sm text-muted">
                        {t('design.emptyPreview')}
                      </div>
                    )}
                  </div>
                )}
                {!isReadOnly && (
                  <div className="flex gap-2">
                    <Button
                      disabled={pending || !systemName.trim() || !systemContent.trim()}
                      onClick={() => void saveSystem()}
                    >
                      {t('design.saveTemplate')}
                    </Button>
                    {editingSystemId && canDelete && (
                      <Button
                        variant="destructive"
                        disabled={pending}
                        onClick={() => void deleteSystem(editingSystemId)}
                      >
                        {t('common.delete')}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </section>
        </main>
      ) : !selected ? (
        <main className="min-w-0 flex-1 overflow-y-auto p-6">
          <section className="mx-auto max-w-2xl space-y-5">
            <header>
              <h1 className="text-xl font-semibold">{t('runtime.designTitle')}</h1>
              <p className="text-sm text-muted">{t('design.subtitle')}</p>
            </header>
            {!isReadOnly && (
              <div className="space-y-4 rounded-xl border border-border bg-surface-1 p-5">
                <div>
                  <label htmlFor="design-provider" className="mb-1.5 block text-sm font-medium">
                    {t('design.repository')}
                  </label>
                  <Select
                    id="design-provider"
                    value={provider}
                    disabled={providers.length === 0}
                    onChange={(event) => setProvider(event.target.value as 'github' | 'azure')}
                  >
                    {providers.length === 0 && (
                      <option value="github">{t('runtime.configureIntegration')}</option>
                    )}
                    {providers.includes('github') && <option value="github">GitHub</option>}
                    {providers.includes('azure') && <option value="azure">Azure DevOps</option>}
                  </Select>
                  {onManageRepositories && canManageRepositories && (
                    <Button
                      className="mt-2"
                      size="sm"
                      variant="ghost"
                      onClick={onManageRepositories}
                    >
                      <i className="ti ti-settings" aria-hidden="true" />{' '}
                      {t('design.manageRepositories')}
                    </Button>
                  )}
                </div>
                <div>
                  <label htmlFor="design-title" className="mb-1.5 block text-sm font-medium">
                    {t('design.projectName')}
                  </label>
                  <Input
                    id="design-title"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder={t('design.projectNamePlaceholder')}
                  />
                </div>
                <div>
                  <label htmlFor="design-agent" className="mb-1.5 block text-sm font-medium">
                    {t('design.agent')}
                  </label>
                  <Select
                    id="design-agent"
                    value={agentId}
                    onChange={(event) => setAgentId(event.target.value)}
                  >
                    <option value="">{t('runtime.selectAgent')}</option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <label htmlFor="design-system" className="mb-1.5 block text-sm font-medium">
                    {t('design.designSystem')}
                  </label>
                  <Select
                    id="design-system"
                    value={designSystemId}
                    onChange={(event) => setDesignSystemId(event.target.value)}
                  >
                    <option value="">{t('runtime.noneSelected')}</option>
                    {systems.map((system) => (
                      <option key={system.id} value={system.id}>
                        {system.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <label htmlFor="design-prompt" className="mb-1.5 block text-sm font-medium">
                    {t('design.describePrototype')}
                  </label>
                  <Textarea
                    id="design-prompt"
                    className="min-h-40"
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    placeholder={t('design.prototypePlaceholder')}
                  />
                </div>
                {imagePicker('design-prototype-images', prototypeImages, setPrototypeImages)}
                <details className="hidden">
                  <summary className="cursor-pointer text-sm font-medium">
                    {t('design.configureSystems')}
                  </summary>
                  <div className="mt-3 space-y-2">
                    <Input
                      aria-label={t('design.systemName')}
                      value={systemName}
                      onChange={(event) => setSystemName(event.target.value)}
                      placeholder={t('design.systemNamePlaceholder')}
                    />
                    <Textarea
                      aria-label={t('design.systemContent')}
                      value={systemContent}
                      onChange={(event) => setSystemContent(event.target.value)}
                      className="min-h-28 font-mono text-xs"
                      placeholder={t('design.systemRulesPlaceholder')}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending || !systemName.trim() || !systemContent.trim()}
                      onClick={() => void saveSystem()}
                    >
                      {t('design.saveSystem')}
                    </Button>
                  </div>
                </details>
                <Button
                  disabled={
                    pending || providers.length === 0 || !title.trim() || !prompt.trim() || !agentId
                  }
                  isLoading={pending}
                  onClick={() => void create()}
                >
                  <i className="ti ti-sparkles" aria-hidden="true" /> {t('design.createWithAgent')}
                </Button>
              </div>
            )}
          </section>
        </main>
      ) : (
        <>
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
              <div className="min-w-0">
                <h1 className="truncate text-sm font-semibold">{selected.title}</h1>
                <p className="text-xs text-muted">
                  {t('design.filesCount', { count: selected.files.length })}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <ModeSwitch mode={mode} onChange={setMode} ariaLabel={t('design.viewMode')} />
                {/*
                <div
                  className="flex items-center gap-0.5 rounded-md border border-border bg-surface-2 p-0.5"
                  role="group"
                  aria-label={t('design.viewMode')}
                >
                  <Button
                    size="sm"
                    variant={mode === 'preview' ? 'secondary' : 'ghost'}
                    className="h-7 w-7 rounded p-0 text-[0px] leading-none [&_i]:text-base [&_i]:leading-none"
                    aria-label="Preview"
                    onClick={() => setMode('preview')}
                  >
                    <i className="ti ti-eye" aria-hidden="true" /> Preview
                  </Button>
                  <Button
                    size="sm"
                    variant={mode === 'code' ? 'secondary' : 'ghost'}
                    className="h-7 w-7 rounded p-0 text-[0px] leading-none [&_i]:text-base [&_i]:leading-none"
                    aria-label={t('common.code')}
                    onClick={() => setMode('code')}
                  >
                    <i className="ti ti-code" aria-hidden="true" /> {t('common.code')}
                  </Button>
                </div> */}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => void pullProject(selected)}
                >
                  <i className="ti ti-download" aria-hidden="true" /> Pull
                </Button>
                <Button size="sm" variant="outline" onClick={() => exportProject(selected)}>
                  <i className="ti ti-download" aria-hidden="true" /> {t('design.export')}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t('design.openPreview')}
                  title={t('design.openPreview')}
                  onClick={() => openHtmlPreview(srcDoc)}
                >
                  <i className="ti ti-external-link" aria-hidden="true" />
                </Button>
                {canDelete && (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t('design.deleteProject')}
                    onClick={() => setDeleteTarget(selected)}
                  >
                    <i className="ti ti-trash text-red-400" aria-hidden="true" />
                  </Button>
                )}
              </div>
            </header>
            <div className="flex min-h-0 flex-1 flex-col">
              {mode === 'preview' ? (
                <iframe
                  title={t('design.projectPreview', { title: selected.title })}
                  sandbox="allow-scripts"
                  srcDoc={srcDoc}
                  className="h-full min-h-0 w-full border-0 bg-white"
                />
              ) : (
                <>
                  <div className="flex items-center gap-1 overflow-x-auto border-b border-border p-2">
                    {selected.files.map((file) => (
                      <Button
                        key={file.name}
                        size="sm"
                        variant={activeFile?.name === file.name ? 'secondary' : 'ghost'}
                        onClick={() => setSelectedFile(file.name)}
                      >
                        {file.name}
                      </Button>
                    ))}
                  </div>
                  <div className="flex min-h-0 flex-1 flex-col p-3">
                    <Textarea
                      aria-label={t('design.fileCode', { name: activeFile?.name ?? '' })}
                      value={activeFile?.content ?? ''}
                      readOnly={isReadOnly}
                      onChange={(event) => updateCode(event.target.value)}
                      className="min-h-0 flex-1 resize-none font-mono text-xs leading-5"
                    />
                    <div className="mt-2 flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => activeFile && download(activeFile.name, activeFile.content)}
                      >
                        {t('design.downloadFile')}
                      </Button>
                      {!isReadOnly && (
                        <Button
                          size="sm"
                          disabled={pending}
                          isLoading={pending}
                          onClick={() => void saveCode(selected)}
                        >
                          Push
                        </Button>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          </main>
          <ResizableSidebar
            aria-label={t('design.conversation')}
            resizeLabel={t('design.resizeConversation')}
            resizeEdge="left"
            defaultWidth={360}
            minWidth={280}
            maxWidth="container"
            className="border-l border-border bg-surface-1"
          >
            {!isReadOnly && (
              <div className="border-b border-border p-3">
                <label
                  htmlFor="design-chat-agent"
                  className="mb-1 block text-xs font-medium text-muted"
                >
                  {t('design.agent')}
                </label>
                <Select
                  id="design-chat-agent"
                  value={agentId}
                  onChange={(event) => setAgentId(event.target.value)}
                >
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <div className="thin-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
              {selected.messages.map((item, index) => (
                <div
                  key={`${item.createdAt}:${item.role}:${index}`}
                  className={
                    item.role === 'user'
                      ? 'ml-8 rounded-xl bg-surface-2 p-3 text-sm'
                      : 'mr-8 text-sm'
                  }
                >
                  <p className="mb-1 text-[10px] font-semibold uppercase text-muted">
                    {item.role === 'user' ? t('design.you') : t('design.agentRole')}
                  </p>
                  {item.images?.map((image, imageIndex) => (
                    <img
                      key={`${image.mimeType}:${imageIndex}`}
                      src={`data:${image.mimeType};base64,${image.data}`}
                      alt={t('design.sentImage')}
                      className="mb-2 max-h-48 max-w-full rounded-lg border border-border object-contain"
                    />
                  ))}
                  <p className="whitespace-pre-wrap">{item.content}</p>
                </div>
              ))}
              {pending && (
                <div className="mr-8 flex items-center gap-2 text-sm text-muted" role="status">
                  <i className="ti ti-sparkles animate-pulse" aria-hidden="true" />
                  {t('design.thinking')}
                </div>
              )}
            </div>
            {!isReadOnly && (
              <div className="border-t border-border p-3">
                {chatImages.length > 0 && (
                  <div
                    className="mb-2 flex flex-wrap gap-2"
                    aria-label={t('design.attachedImages')}
                  >
                    {chatImages.map((image) => (
                      <img
                        key={image.name}
                        src={image.preview}
                        alt={image.name}
                        className="h-14 w-14 rounded-md border border-border object-cover"
                      />
                    ))}
                  </div>
                )}
                <Textarea
                  aria-label={t('design.agentMessage')}
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  disabled={pending}
                  className="mb-2 min-h-24"
                  placeholder={t('design.messagePlaceholder')}
                />
                <label
                  htmlFor="design-chat-images"
                  className="mb-2 inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-muted hover:text-[var(--text-primary)]"
                >
                  <i className="ti ti-photo-plus" aria-hidden="true" /> {t('runtime.addImages')}
                </label>
                <input
                  id="design-chat-images"
                  className="sr-only"
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  multiple
                  disabled={pending}
                  onChange={(event) => {
                    addChatImages([...(event.target.files ?? [])]);
                    event.target.value = '';
                  }}
                />
                <Button
                  className="w-full"
                  disabled={pending || (!message.trim() && !chatImages.length)}
                  isLoading={pending}
                  onClick={() => void chat(selected)}
                >
                  <i className="ti ti-send" aria-hidden="true" /> {t('design.send')}
                </Button>
              </div>
            )}
          </ResizableSidebar>
        </>
      )}
      {toast && (
        <Toast message={toast.message} variant={toast.variant} onDismiss={() => setToast(null)} />
      )}
      {deleteTarget && (
        <ConfirmationDialog
          open
          title={t('design.deletePrototype')}
          description={t('design.deletePrototypeDescription', { title: deleteTarget.title })}
          confirmLabel={t('common.delete')}
          cancelLabel={t('common.cancel')}
          destructive
          isLoading={pending}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            const target = deleteTarget;
            setPending(true);
            void runActivity(
              { kind: 'push', title: t('design.deletingPrototype', { title: target.title }) },
              () => apiClient.deleteDesignProject(target.id, target.provider),
            )
              .then(() => {
                setProjects((all) =>
                  all.filter((item) => item.id !== target.id || item.provider !== target.provider),
                );
                setSelected(null);
                setDeleteTarget(null);
                setToast({ message: t('design.prototypeDeleted'), variant: 'success' });
              })
              .catch((error: unknown) =>
                setToast({
                  message: error instanceof Error ? error.message : t('design.deleteFailed'),
                  variant: 'error',
                }),
              )
              .finally(() => setPending(false));
          }}
        />
      )}
    </div>
  );
}
