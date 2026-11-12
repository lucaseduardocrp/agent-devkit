import { useState } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { E2eExploration } from './E2eExploration.js';
import { E2eSources } from './E2eSources.js';

export interface E2eSourcesPageProps {
  readonly apiClient: ApiClient;
  readonly isReadOnly?: boolean;
}

/**
 * The Sources page of the Test module: the map of every flow of the application and, while it
 * is being drawn again, the agent exploring the application live.
 */
export function E2eSourcesPage({ apiClient, isReadOnly = false }: E2eSourcesPageProps) {
  /** Hidden run whose exploration is being followed. */
  const [exploring, setExploring] = useState<string | null>(null);

  if (exploring)
    return (
      <E2eExploration
        apiClient={apiClient}
        creationId={exploring}
        isReadOnly={isReadOnly}
        following
        onBack={() => setExploring(null)}
      />
    );
  return <E2eSources apiClient={apiClient} isReadOnly={isReadOnly} onExplore={setExploring} />;
}
