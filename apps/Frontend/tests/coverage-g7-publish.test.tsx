import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { PublishTestSuiteModal } from '../src/features/testplans/PublishTestSuiteModal.js';
import type { ApiClient, TestSuiteDto } from '../src/lib/api-client.js';
import type { PbiItem } from '../src/features/pbi/pbi-types.js';

const suite = { id: 'suite-1', name: 'Regression' } as TestSuiteDto;

function boardItem(id: string, title: string, sourceData: Record<string, unknown>): PbiItem {
  return {
    id,
    workspaceId: 'ws',
    parentId: null,
    kind: 'pbi',
    title,
    description: '',
    status: 'New',
    position: 0,
    sourceData,
    links: [
      {
        id: `${id}-l`,
        providerId: 'azure_devops',
        externalId: id.toUpperCase(),
        externalUrl: null,
        boardId: null,
        syncedAt: '',
      },
    ],
    createdAt: '',
    updatedAt: '',
    partial: true,
  };
}

type Api = Record<
  | 'getTestSuiteProviders'
  | 'getRemoteTestPlans'
  | 'getRemoteTestSuites'
  | 'getPbiItems'
  | 'getTestSuiteFieldSources',
  Mock
>;

function client(overrides: Record<string, unknown> = {}): Api {
  return {
    getTestSuiteProviders: vi.fn().mockResolvedValue([
      { id: 'azure_devops', name: 'Azure DevOps', configured: true },
      { id: 'testrail', name: 'TestRail', configured: false },
    ]),
    getRemoteTestPlans: vi.fn().mockResolvedValue([{ id: '7', name: 'Plan' }]),
    getRemoteTestSuites: vi.fn().mockResolvedValue([
      { id: '11', name: 'Root', suiteType: 'staticTestSuite', parentId: null },
      // The parent of this suite is not in the list, so its label stops at its own name.
      { id: '12', name: 'Orphan', suiteType: 'staticTestSuite', parentId: '999' },
    ]),
    getPbiItems: vi.fn().mockResolvedValue([boardItem('p1', 'Typed', { type: 5 })]),
    ...overrides,
  } as Api;
}

function open(api: ReturnType<typeof client>, onPublish = vi.fn()) {
  render(
    <PublishTestSuiteModal
      apiClient={api as unknown as ApiClient}
      suite={suite}
      onClose={vi.fn()}
      onPublish={onPublish}
      onPublished={vi.fn()}
    />,
  );
  return screen.getByRole('dialog');
}

describe('PublishTestSuiteModal load failures', () => {
  it('shows a generic message for a provider failure and retries', async () => {
    const api = client();
    api.getTestSuiteProviders.mockRejectedValueOnce('offline');
    const dialog = open(api);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Não foi possível carregar os destinos.',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => expect(api.getTestSuiteProviders).toHaveBeenCalledTimes(2));
    const select = await within(dialog).findByLabelText('Provedor');
    // The provider that is not configured is offered but cannot be picked.
    expect(
      within(select).getByRole('option', { name: /TestRail — Não configurado/ }),
    ).toHaveProperty('disabled', true);
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('asks to configure a provider when none is configured', async () => {
    const api = client();
    api.getTestSuiteProviders.mockResolvedValue([
      { id: 'testrail', name: 'TestRail', configured: false },
    ]);
    const dialog = open(api);
    expect(
      await within(dialog).findByText('Configure uma integração de testes antes de publicar.'),
    ).toBeInTheDocument();
  });

  it('reports plan and suite loading failures that are not Error instances', async () => {
    const api = client();
    api.getRemoteTestPlans.mockRejectedValueOnce('plans down');
    const dialog = open(api);
    fireEvent.change(await within(dialog).findByLabelText('Provedor'), {
      target: { value: 'azure_devops' },
    });
    fireEvent.change(within(dialog).getByLabelText('Destino'), { target: { value: 'existing' } });
    expect(await within(dialog).findByText('Não foi possível carregar os destinos.')).toBeTruthy();
    // Retrying loads the plans, then the suites fail with a plain value too.
    api.getRemoteTestSuites.mockRejectedValueOnce('suites down');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tentar novamente' }));
    fireEvent.change(await within(dialog).findByLabelText('Test Plan de destino'), {
      target: { value: '7' },
    });
    expect(await within(dialog).findByText('Não foi possível carregar os destinos.')).toBeTruthy();
  });

  it('reports a board failure with its message', async () => {
    const api = client();
    api.getPbiItems.mockRejectedValueOnce(new Error('Board offline'));
    const dialog = open(api);
    fireEvent.change(await within(dialog).findByLabelText('Provedor'), {
      target: { value: 'azure_devops' },
    });
    expect(await within(dialog).findByText('Board offline')).toBeInTheDocument();
  });

  it('uses the default board message when the failure carries none', async () => {
    const api = client();
    api.getPbiItems.mockRejectedValueOnce('nope');
    const dialog = open(api);
    fireEvent.change(await within(dialog).findByLabelText('Provedor'), {
      target: { value: 'azure_devops' },
    });
    expect(
      await within(dialog).findByText('Não foi possível carregar os itens do board.'),
    ).toBeInTheDocument();
  });
});

describe('PublishTestSuiteModal destinations and publishing', () => {
  it('labels suites by their known parents and offers items without a text type', async () => {
    const api = client();
    const onPublish = vi.fn().mockRejectedValue('provider refused');
    const dialog = open(api, onPublish);
    fireEvent.change(await within(dialog).findByLabelText('Provedor'), {
      target: { value: 'azure_devops' },
    });
    fireEvent.change(within(dialog).getByLabelText('Destino'), { target: { value: 'existing' } });
    fireEvent.change(await within(dialog).findByLabelText('Test Plan de destino'), {
      target: { value: '7' },
    });
    const parent = await within(dialog).findByLabelText('Suite de destino');
    expect(within(parent).getByRole('option', { name: /Orphan/ })).toBeInTheDocument();
    fireEvent.change(parent, { target: { value: '12' } });
    // A board item whose type is not text still has its option.
    fireEvent.focus(
      await within(dialog).findByRole('combobox', { name: 'Work items vinculados (opcional)' }),
    );
    expect(within(dialog).getByRole('option', { name: /#P1/ })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publicar suite' }));
    // A refusal that is not an Error falls back to the default message.
    expect(await within(dialog).findByText('Falha ao publicar a suite de testes.')).toBeTruthy();
    expect(onPublish).toHaveBeenCalledOnce();
  });

  it('keeps working when the client has no field mapping or source support', async () => {
    const api = client();
    const dialog = open(api);
    fireEvent.change(await within(dialog).findByLabelText('Provedor'), {
      target: { value: 'azure_devops' },
    });
    expect(within(dialog).queryByRole('region', { name: 'Mapeamento de campos' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Publicar suite' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('survives a failure loading the custom field sources', async () => {
    const failing = client({
      getTestSuiteFieldSources: vi.fn().mockRejectedValue(new Error('no sources')),
      getFieldMappingTemplates: vi.fn().mockResolvedValue([]),
      getTestCaseFieldCatalog: vi.fn().mockResolvedValue([]),
    });
    const dialog = open(failing);
    fireEvent.change(await within(dialog).findByLabelText('Provedor'), {
      target: { value: 'azure_devops' },
    });
    await waitFor(() => expect(failing.getTestSuiteFieldSources).toHaveBeenCalledWith('suite-1'));
    expect(
      await within(dialog).findByRole('region', { name: 'Mapeamento de campos' }),
    ).toBeInTheDocument();
  });

  it('feeds the custom sources of the suite into the mapping editor', async () => {
    const api = client({
      getTestSuiteFieldSources: vi
        .fn()
        .mockResolvedValue([{ providerId: 'testrail', key: 'Custom.Priority' }]),
      getFieldMappingTemplates: vi.fn().mockResolvedValue([]),
      getTestCaseFieldCatalog: vi
        .fn()
        .mockResolvedValue([{ id: 'Custom.Flow', name: 'Fluxo', type: 'text' }]),
    });
    const dialog = open(api);
    fireEvent.change(await within(dialog).findByLabelText('Provedor'), {
      target: { value: 'azure_devops' },
    });
    const region = await within(dialog).findByRole('region', { name: 'Mapeamento de campos' });
    await waitFor(() => expect(api.getTestSuiteFieldSources).toHaveBeenCalled());
    expect(region).toBeInTheDocument();
  });
});

describe('PublishTestSuiteModal Error messages', () => {
  it('shows the message of the Error that stopped each load', async () => {
    const api = client();
    api.getTestSuiteProviders.mockRejectedValueOnce(new Error('providers down'));
    const dialog = open(api);
    expect(await within(dialog).findByText('providers down')).toBeInTheDocument();
    api.getRemoteTestPlans.mockRejectedValueOnce(new Error('plans down'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tentar novamente' }));
    fireEvent.change(await within(dialog).findByLabelText('Provedor'), {
      target: { value: 'azure_devops' },
    });
    fireEvent.change(within(dialog).getByLabelText('Destino'), { target: { value: 'existing' } });
    expect(await within(dialog).findByText('plans down')).toBeInTheDocument();
    api.getRemoteTestSuites.mockRejectedValueOnce(new Error('suites down'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tentar novamente' }));
    fireEvent.change(await within(dialog).findByLabelText('Test Plan de destino'), {
      target: { value: '7' },
    });
    expect(await within(dialog).findByText('suites down')).toBeInTheDocument();
  });
});
