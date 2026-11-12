import { useEffect, useState, type FormEvent } from 'react';
import { Modal } from '../../components/ui/modal.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Select } from '../../components/ui/select.js';
import { useI18n } from '../../lib/i18n/index.js';
import type {
  ApiClient,
  KnowledgeDocumentDto,
  KnowledgePushDestinationDto,
  KnowledgePushInput,
  KnowledgePushProviderDto,
} from '../../lib/api-client.js';

interface Props {
  apiClient: ApiClient;
  document: KnowledgeDocumentDto;
  documents: readonly KnowledgeDocumentDto[];
  pushing: boolean;
  onClose: () => void;
  onPush: (
    input: KnowledgePushInput,
    providerName: string,
  ) => Promise<{ success: boolean; error?: string }>;
}
function suggestedParentPath(
  document: KnowledgeDocumentDto,
  documents: readonly KnowledgeDocumentDto[],
): string {
  const byId = new Map(documents.map((item) => [item.pageId, item]));
  const segments: string[] = [];
  const visited = new Set<string>([document.pageId]);
  let parentId = document.parentPageId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    if (parent.pagePath)
      return `${parent.pagePath.replace(/\/$/, '')}/${segments.reverse().join('/')}`.replace(
        /\/$/,
        '',
      );
    segments.push(parent.title);
    parentId = parent.parentPageId;
  }
  return segments.length ? `/${segments.reverse().join('/')}` : '';
}

export function BrainPushModal({
  apiClient,
  document,
  documents,
  pushing,
  onClose,
  onPush,
}: Props) {
  const { messages } = useI18n();
  const c = messages.brainPush;
  const [providers, setProviders] = useState<readonly KnowledgePushProviderDto[]>([]);
  const [providerId, setProviderId] = useState('');
  const [destinations, setDestinations] = useState<readonly KnowledgePushDestinationDto[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [loadingDestinations, setLoadingDestinations] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parentPath, setParentPath] = useState(() => suggestedParentPath(document, documents));
  const [wikiIdentifier, setWikiIdentifier] = useState('');
  const [listId, setListId] = useState('');
  const [parentExternalId, setParentExternalId] = useState('');
  const [issueType, setIssueType] = useState('Task');
  const provider = providers.find((item) => item.providerId === providerId);
  const setting = (key: string): string => {
    const value = provider?.settings[key];
    return typeof value === 'string' ? value : '';
  };

  useEffect(() => {
    let active = true;
    void apiClient.getKnowledgePushProviders().then(
      (items) => {
        if (!active) return;
        setProviders(items);
        setProviderId(items[0]?.providerId ?? '');
        setLoadingProviders(false);
      },
      (cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoadingProviders(false);
      },
    );
    return () => {
      active = false;
    };
  }, [apiClient]);

  useEffect(() => {
    if (!providerId) return;
    setDestinations([]);
    setLoadingDestinations(true);
    setError(null);
    setListId('');
    setParentExternalId('');
    setParentPath(suggestedParentPath(document, documents));
    setWikiIdentifier(setting('wikiIdentifier'));
    let active = true;
    void apiClient.getKnowledgePushDestinations(providerId).then(
      (items) => {
        if (active) {
          setDestinations(items);
          setLoadingDestinations(false);
        }
      },
      (cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setLoadingDestinations(false);
        }
      },
    );
    return () => {
      active = false;
    };
    // Settings and the suggested path are reset only when the selected provider changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiClient, providerId]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!provider || pushing) return;
    const destination: KnowledgePushInput['destination'] =
      providerId === 'azure_devops_wiki'
        ? { parentPath, wikiIdentifier }
        : providerId === 'trello'
          ? { listId }
          : { parentExternalId, ...(providerId === 'jira' ? { issueType } : {}) };
    setError(null);
    void onPush({ providerId, destination }, provider.name).then((result) => {
      if (result.success) onClose();
      else setError(result.error ?? c.pushFailed);
    });
  };

  return (
    <Modal
      open
      labelledBy="brain-push-title"
      onClose={pushing ? undefined : onClose}
      closeOnBackdrop={!pushing}
    >
      <form
        onSubmit={submit}
        className="w-[min(100vw-2rem,34rem)] space-y-4 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-6 shadow-2xl"
      >
        <div>
          <h2 id="brain-push-title" className="text-lg font-semibold">
            {c.title}
          </h2>
          <p className="mt-1 truncate text-sm text-[var(--text-muted)]" title={document.title}>
            {document.title}
          </p>
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-400">
            {error}
          </p>
        )}
        <label className="block space-y-1 text-sm">
          <span>{c.provider}</span>
          <Select
            value={providerId}
            onChange={(event) => setProviderId(event.target.value)}
            disabled={pushing || loadingProviders || providers.length === 0}
            required
          >
            {providers.length === 0 && (
              <option value="">{loadingProviders ? c.loading : c.noProviders}</option>
            )}
            {providers.map((item) => (
              <option key={item.providerId} value={item.providerId}>
                {item.name}
              </option>
            ))}
          </Select>
        </label>
        {providerId === 'azure_devops_wiki' && (
          <>
            <label className="block space-y-1 text-sm">
              <span>{c.wiki}</span>
              <Input
                value={wikiIdentifier}
                onChange={(event) => setWikiIdentifier(event.target.value)}
                placeholder={setting('wikiIdentifier')}
              />
            </label>
            <label className="block space-y-1 text-sm">
              <span>{c.parentPage}</span>
              <Select
                value={destinations.some((item) => item.id === parentPath) ? parentPath : ''}
                onChange={(event) => setParentPath(event.target.value)}
              >
                <option value="">{c.root}</option>
                {destinations.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="block space-y-1 text-sm">
              <span>{c.path}</span>
              <Input
                value={parentPath}
                onChange={(event) => setParentPath(event.target.value)}
                placeholder={c.pathExample}
              />
            </label>
            <p className="text-xs text-[var(--text-muted)]">{c.pathHint}</p>
            <p className="break-all text-xs text-[var(--text-secondary)]">
              {c.preview}: {(parentPath.replace(/\/$/, '') || '') + '/' + document.title}
            </p>
          </>
        )}
        {providerId === 'trello' && (
          <>
            <p className="text-sm text-[var(--text-muted)]">
              {c.board}: {setting('boardId')}
            </p>
            <label className="block space-y-1 text-sm">
              <span>{c.list}</span>
              <Select
                value={destinations.some((item) => item.id === listId) ? listId : ''}
                onChange={(event) => setListId(event.target.value)}
              >
                <option value="">{c.noParent}</option>
                {destinations.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="block space-y-1 text-sm">
              <span>{c.listId}</span>
              <Input value={listId} onChange={(event) => setListId(event.target.value)} required />
            </label>
            <p className="text-xs text-[var(--text-muted)]">{c.trelloHint}</p>
          </>
        )}
        {(providerId === 'github_projects' || providerId === 'jira') && (
          <>
            <p className="text-sm text-[var(--text-muted)]">
              {c.project}:{' '}
              {providerId === 'jira'
                ? setting('projectKey')
                : `${setting('owner')}/${setting('repo')} · #${setting('projectNumber')}`}
            </p>
            <label className="block space-y-1 text-sm">
              <span>{c.parentIssue}</span>
              <Select
                value={
                  destinations.some((item) => item.id === parentExternalId) ? parentExternalId : ''
                }
                onChange={(event) => setParentExternalId(event.target.value)}
              >
                <option value="">{c.noParent}</option>
                {destinations.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="block space-y-1 text-sm">
              <span>{c.parentIssueId}</span>
              <Input
                value={parentExternalId}
                onChange={(event) => setParentExternalId(event.target.value)}
              />
            </label>
            {providerId === 'jira' && (
              <label className="block space-y-1 text-sm">
                <span>{c.issueType}</span>
                <Input
                  value={issueType}
                  onChange={(event) => setIssueType(event.target.value)}
                  required
                />
              </label>
            )}
          </>
        )}
        {loadingDestinations && <p className="text-xs text-[var(--text-muted)]">{c.loading}</p>}
        {!loadingDestinations && providerId && destinations.length === 0 && (
          <p className="text-xs text-[var(--text-muted)]">{c.noDestinations}</p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={pushing}>
            {c.cancel}
          </Button>
          <Button
            type="submit"
            disabled={!providerId || pushing || (providerId === 'trello' && !listId.trim())}
            isLoading={pushing}
          >
            {c.publish}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
