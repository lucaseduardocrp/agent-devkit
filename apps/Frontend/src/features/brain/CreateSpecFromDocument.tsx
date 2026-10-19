import { createPortal } from 'react-dom';
import { Toast } from '../../components/ui/toast.js';
import { useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { Select } from '../../components/ui/select.js';
import type { ApiClient, KnowledgeDocumentDto } from '../../lib/api-client.js';
import { useI18n } from '../../lib/i18n/index.js';
import type { CustomAgentDto } from '../agents/agent-types.js';
import { useActivityRunner } from '../activities/ActivityCenter.js';

export function CreateSpecFromDocument({
  apiClient,
  document,
}: {
  apiClient: ApiClient;
  document: KnowledgeDocumentDto;
}) {
  const { t } = useI18n();
  const { runActivity } = useActivityRunner();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [agents, setAgents] = useState<readonly CustomAgentDto[]>([]);
  const [agentId, setAgentId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [createdTitle, setCreatedTitle] = useState<string | null>(null);
  const reportError = (error: unknown) =>
    setError(error instanceof Error ? error.message : t('spec.workflowFailed'));
  const start = async () => {
    setOpen(true);
    setLoading(true);
    setError(null);
    setCreatedTitle(null);
    setAgentId('');
    try {
      setAgents(await apiClient.getAgents());
    } catch (error) {
      reportError(error);
    } finally {
      setLoading(false);
    }
  };
  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const spec = await runActivity(
        { kind: 'agent', title: `Criando Spec para “${document.title}”` },
        () =>
          apiClient.createSpecificationFromKnowledge({
            pageId: document.pageId,
            source: document.source,
            title: document.title,
            agentId,
          }),
      );
      setCreatedTitle(spec.title);
      setOpen(false);
    } catch (error) {
      reportError(error);
    } finally {
      setGenerating(false);
    }
  };
  return (
    <div>
      <Button
        size="sm"
        variant="secondary"
        leftIcon={<i className="ti ti-file-description text-base" aria-hidden="true" />}
        onClick={() => void start()}
      >
        {t('spec.fromBrain')}
      </Button>
      {createdTitle &&
        createPortal(
          <Toast
            message={t('spec.generated', { title: createdTitle })}
            dismissLabel={t('spec.closeNotification')}
            onDismiss={() => setCreatedTitle(null)}
          />,
          window.document.body,
        )}
      {open &&
        createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
            <section
              role="dialog"
              aria-modal="true"
              aria-label={t('spec.fromBrain')}
              className="w-full max-w-lg space-y-4 rounded-lg border border-border bg-surface-1 p-6"
            >
              <h2 className="text-lg font-semibold">{t('spec.fromBrain')}</h2>
              <p className="text-sm">{document.title}</p>
              <p className="text-sm text-[var(--text-secondary)]">{t('spec.fromBrainHint')}</p>
              {loading ? (
                <p role="status">{t('common.loading')}</p>
              ) : (
                <>
                  <Select
                    aria-label={t('spec.selectAgent')}
                    value={agentId}
                    disabled={generating}
                    onChange={(event) => setAgentId(event.target.value)}
                  >
                    <option value="">{t('spec.selectAgent')}</option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </Select>
                  {agents.length === 0 && <p>{t('spec.noAgents')}</p>}
                </>
              )}
              {error && <p role="alert">{error}</p>}
              <div className="flex gap-2">
                <Button
                  disabled={loading || generating || !agentId}
                  isLoading={generating}
                  onClick={() => void generate()}
                >
                  {t('common.confirm')}
                </Button>
                <Button variant="secondary" disabled={generating} onClick={() => setOpen(false)}>
                  {t('common.cancel')}
                </Button>
              </div>
            </section>
          </div>,
          window.document.body,
        )}
    </div>
  );
}
