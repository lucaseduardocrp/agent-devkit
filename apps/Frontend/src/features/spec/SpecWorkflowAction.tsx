import { createPortal } from 'react-dom';
import { Toast } from '../../components/ui/toast.js';
import { useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { ConfirmationDialog } from '../../components/ui/confirmation-dialog.js';
import type { ApiClient, SpecificationDto } from '../../lib/api-client.js';
import { useI18n } from '../../lib/i18n/index.js';
import { useActivityRunner } from '../activities/ActivityCenter.js';

export function SpecWorkflowAction({
  apiClient,
  spec,
  action,
  disabled,
  onCleared,
  iconOnly = false,
}: {
  apiClient: ApiClient;
  spec: SpecificationDto;
  action: 'clear' | 'publish';
  disabled: boolean;
  onCleared: (spec: SpecificationDto) => void;
  iconOnly?: boolean;
}) {
  const { t } = useI18n();
  const { runActivity } = useActivityRunner();
  const [pending, setPending] = useState(false);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; message: string } | null>(null);
  const execute = async () => {
    setConfirmationOpen(false);
    setPending(true);
    setFeedback(null);
    try {
      if (action === 'clear') onCleared(await apiClient.clearSpecificationMessages(spec.id));
      else
        await runActivity({ kind: 'push', title: `Publicando “${spec.title}” no Docs` }, () =>
          apiClient.publishSpecification(spec.id),
        );
      setFeedback({
        error: false,
        message: t(action === 'clear' ? 'spec.contextCleared' : 'spec.publishedBrain'),
      });
    } catch (error) {
      setFeedback({
        error: true,
        message: error instanceof Error ? error.message : t('spec.workflowFailed'),
      });
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="my-2 min-w-0">
      <Button
        variant="secondary"
        size="sm"
        className={iconOnly ? 'shrink-0 px-2' : undefined}
        aria-label={iconOnly ? t('spec.clearContext') : undefined}
        title={iconOnly ? t('spec.clearContext') : undefined}
        disabled={disabled || pending}
        isLoading={pending}
        onClick={() => (action === 'clear' ? setConfirmationOpen(true) : void execute())}
      >
        <i className={`ti ${action === 'clear' ? 'ti-eraser' : 'ti-brain'}`} aria-hidden="true" />
        {!iconOnly && t(action === 'clear' ? 'spec.clearContext' : 'spec.publishBrain')}
      </Button>
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
      {createPortal(
        <ConfirmationDialog
          open={confirmationOpen}
          title={t('spec.clearContext')}
          description={t('spec.clearContextConfirm')}
          confirmLabel={t('common.confirm')}
          cancelLabel={t('common.cancel')}
          destructive
          isLoading={pending}
          onCancel={() => setConfirmationOpen(false)}
          onConfirm={() => void execute()}
        />,
        document.body,
      )}
    </div>
  );
}
