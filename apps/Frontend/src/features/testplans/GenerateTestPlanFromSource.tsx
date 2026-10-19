/* v8 ignore file -- covered by Brain and Spec integration journeys. */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../components/ui/button.js';
import { Select } from '../../components/ui/select.js';
import { Toast } from '../../components/ui/toast.js';
import type { ApiClient, TestSuiteDto } from '../../lib/api-client.js';
import type { CustomAgentDto } from '../agents/agent-types.js';
import { useActivityRunner } from '../activities/ActivityCenter.js';
import { useI18n } from '../../lib/i18n/index.js';

export function GenerateTestPlanFromSource({
  apiClient,
  title,
  content,
  sourceType,
  sourceId,
  disabled = false,
}: {
  apiClient: ApiClient;
  title: string;
  content: string;
  sourceType: 'brain' | 'spec';
  sourceId: string;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const { runActivity } = useActivityRunner();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [suites, setSuites] = useState<readonly TestSuiteDto[]>([]);
  const [agents, setAgents] = useState<readonly CustomAgentDto[]>([]);
  const [suiteId, setSuiteId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [feedback, setFeedback] = useState<{ message: string; error: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setOpen(true);
    setLoading(true);
    setError(null);
    setSuiteId('');
    setAgentId('');
    try {
      const [loadedSuites, loadedAgents] = await Promise.all([
        apiClient.getTestSuites(),
        apiClient.getAgents(),
      ]);
      setSuites(loadedSuites);
      setAgents(loadedAgents);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('errors.networkError'));
    } finally {
      setLoading(false);
    }
  };

  // The generate button stays disabled until both a suite and an agent are chosen.
  const generate = () => {
    setPending(true);
    setError(null);
    setOpen(false);
    void runActivity({ kind: 'agent', title: t('testplans.generatingFromSource', { title }) }, () =>
      apiClient.generateTestPlan(content, { title, sourceType, sourceId, suiteId, agentId }),
    )
      .then((result) => {
        setFeedback({
          message: t('testplans.generatedCases', { count: result.plans.length }),
          error: false,
        });
      })
      .catch((generationError: unknown) => {
        const message =
          generationError instanceof Error ? generationError.message : t('errors.networkError');
        setError(message);
        setFeedback({ message, error: true });
      })
      .finally(() => setPending(false));
  };

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={disabled || !content.trim()}
        onClick={() => void start()}
        leftIcon={<i className="ti ti-wand" aria-hidden="true" />}
      >
        {t('testplans.generateTests')}
      </Button>
      {open &&
        createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
            <section
              role="dialog"
              aria-modal="true"
              aria-labelledby="generate-tests-from-source-title"
              className="w-full max-w-lg space-y-4 rounded-lg border border-border bg-surface-1 p-6"
            >
              <div>
                <h2 id="generate-tests-from-source-title" className="text-lg font-semibold">
                  {t('testplans.generateTests')}
                </h2>
                <p className="mt-1 text-sm text-muted">{title}</p>
              </div>
              {loading ? (
                <p role="status">{t('common.loading')}</p>
              ) : (
                <>
                  <Select
                    aria-label={t('testplans.testSuite')}
                    value={suiteId}
                    disabled={pending}
                    onChange={(event) => setSuiteId(event.target.value)}
                  >
                    <option value="">{t('testplans.selectSuite')}</option>
                    {suites.map((suite) => (
                      <option key={suite.id} value={suite.id}>
                        {suite.name}
                      </option>
                    ))}
                  </Select>
                  <Select
                    aria-label={t('testplans.selectGenerationAgent')}
                    value={agentId}
                    disabled={pending}
                    onChange={(event) => setAgentId(event.target.value)}
                  >
                    <option value="">{t('testplans.selectGenerationAgent')}</option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </Select>
                  {suites.length === 0 && (
                    <p className="text-sm text-muted">{t('testplans.noSuites')}</p>
                  )}
                  {agents.length === 0 && (
                    <p className="text-sm text-muted">{t('spec.noAgents')}</p>
                  )}
                </>
              )}
              {error && <p role="alert">{error}</p>}
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  disabled={loading || pending || !suiteId || !agentId}
                  isLoading={pending}
                  onClick={() => void generate()}
                >
                  {t('testplans.generateTests')}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => setOpen(false)}
                >
                  {t('common.cancel')}
                </Button>
              </div>
            </section>
          </div>,
          document.body,
        )}
      {feedback &&
        createPortal(
          <Toast
            message={feedback.message}
            variant={feedback.error ? 'error' : 'success'}
            dismissLabel={t('spec.closeNotification')}
            onDismiss={() => setFeedback(null)}
          />,
          document.body,
        )}
    </>
  );
}
