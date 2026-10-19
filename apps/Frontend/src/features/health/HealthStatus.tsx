import { useEffect, useState } from 'react';
import { ApiClient, type HealthResponse } from '../../lib/api-client.js';
import { useI18n } from '../../lib/i18n/index.js';

interface HealthStatusProps {
  readonly client?: ApiClient;
}

export function HealthStatus({ client = new ApiClient() }: HealthStatusProps) {
  const { t } = useI18n();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void client
      .getHealth(controller.signal)
      .then(setHealth)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : t('runtime.serviceUnavailable'));
        }
      });

    return () => controller.abort();
  }, [client, t]);

  if (error) return <p role="alert">{error}</p>;
  if (!health) return <p aria-busy="true">{t('runtime.loadingServiceStatus')}</p>;
  return <p role="status">{t('runtime.serviceStatus', { status: health.status })}</p>;
}
