import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { E2eTestDetail } from '../src/features/e2e/E2eTestDetail.js';
import type { E2eTestDetail as Dto } from '../src/features/e2e/e2e-types.js';
import type { ApiClient } from '../src/lib/api-client.js';

const detail: Dto = {
  id: 't1',
  creationId: 'c1',
  position: 1,
  code: 'TC001',
  title: 'Login',
  description: 'Validar o login.',
  steps: ['Abrir login'],
  priority: 'medium',
  status: 'passed',
  error: null,
  analysis: null,
  verdict: null,
  durationMs: 1_000,
  attempts: 1,
  hasVideo: false,
  externalCase: null,
  stepResults: [
    {
      position: 1,
      title: 'Abrir a tela de login',
      status: 'passed',
      durationMs: 1_000,
      error: null,
      hasScreenshot: false,
    },
  ],
  createdAt: '2026-01-30T09:23:00Z',
  updatedAt: '2026-01-30T09:27:00Z',
  lastRunAt: '2026-01-30T09:27:00Z',
  scriptPath: 'tests/e2e/tc001.spec.ts',
  logs: null,
  creation: {
    id: 'c1',
    name: 'ama',
    mode: 'frontend',
    baseUrl: 'https://app.example.test',
    path: '/',
    status: 'completed',
  },
};

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:video');
  URL.revokeObjectURL = vi.fn();
});

function setup(test: Dto) {
  const client = {
    getE2eTest: vi.fn().mockResolvedValue(test),
    getE2eTestVideo: vi.fn().mockResolvedValue(new Blob(['video'])),
    getE2eTestVideoUrl: vi.fn().mockResolvedValue(null),
    rerunE2eTest: vi.fn(),
    getE2eScript: vi.fn(),
    pushE2eScript: vi.fn(),
  };
  render(<E2eTestDetail apiClient={client as unknown as ApiClient} testId="t1" onBack={vi.fn()} />);
  return client;
}

describe('E2eTestDetail executed steps', () => {
  it('shows the executed steps of a finished test', async () => {
    setup(detail);
    expect(await screen.findByTestId('e2e-executed-steps')).toBeInTheDocument();
    expect(screen.getByText('1. Abrir a tela de login')).toBeInTheDocument();
  });

  it('hides the executed steps while the test is running again', async () => {
    setup({ ...detail, status: 'running' });
    await screen.findByText('TC001-Login');
    expect(screen.queryByTestId('e2e-executed-steps')).toBeNull();
  });
});
