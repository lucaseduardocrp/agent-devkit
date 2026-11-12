import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { E2eConfigForm } from '../src/features/e2e/E2eConfigForm.js';
import type { ApiClient } from '../src/lib/api-client.js';

describe('E2eConfigForm default execution target', () => {
  it('keeps the user computer when it was chosen before the server answered', async () => {
    let answer!: (value: unknown) => void;
    const client = {
      apiUrl: 'https://api.adk.example.com',
      getCapabilities: vi.fn(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      ),
      getE2eRunners: vi.fn().mockResolvedValue([]),
      getAgents: vi.fn().mockResolvedValue([]),
      getE2eRepositories: vi.fn().mockResolvedValue({ repositories: [], warnings: [] }),
      getE2eBranches: vi.fn().mockResolvedValue([]),
    };
    const view = render(
      <E2eConfigForm
        apiClient={client as unknown as ApiClient}
        onCreated={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await waitFor(() => expect(client.getCapabilities).toHaveBeenCalled());
    fireEvent.click(view.getByRole('radio', { name: 'Meu computador' }));
    await act(async () => {
      answer({ workersReachLocalhost: false, defaultExecutionTarget: 'local' });
    });
    expect(view.getByRole('radio', { name: 'Meu computador' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });
});
