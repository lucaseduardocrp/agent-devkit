import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { HealthStatus } from '../src/features/health/HealthStatus.js';
import { ApiClient } from '../src/lib/api-client.js';

const containers: HTMLDivElement[] = [];

afterEach(() => {
  for (const container of containers) container.remove();
  containers.length = 0;
});

function mount(client: ApiClient): HTMLDivElement {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  act(() => createRoot(container).render(<HealthStatus client={client} />));
  return container;
}

describe('HealthStatus', () => {
  it('renders loading and then healthy state', async () => {
    const client = new ApiClient({
      fetcher: async () =>
        ({
          ok: true,
          json: async () => ({ status: 'ok', requestId: 'request-1' }),
        }) as Response,
    });
    const container = mount(client);
    expect(container.textContent).toContain('Carregando status do serviço...');
    await act(async () => undefined);
    expect(container.textContent).toContain('Serviço: ok');
  });

  it('renders a safe error state', async () => {
    const client = new ApiClient({
      fetcher: async () => ({ ok: false, status: 503, json: async () => ({}) }) as Response,
    });
    const container = mount(client);
    await act(async () => undefined);
    expect(container.textContent).toContain('Falha de conexão com o servidor.');
  });

  it('uses a generic message for non-Error failures', async () => {
    const client = new ApiClient({
      fetcher: async () => {
        throw 'network failure';
      },
    });
    const container = mount(client);
    await act(async () => undefined);
    expect(container.textContent).toContain('O serviço está indisponível.');
  });
});
