import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublishTestSuiteModal } from '../src/features/testplans/PublishTestSuiteModal.js';
import { TestCaseModal } from '../src/features/testplans/TestCaseModal.js';
import { sanitizeRichText } from '../src/features/testplans/test-case-fields.js';
import type { TestCase } from '../src/features/testplans/TestPlansView.js';
import { MediaProvider } from '../src/features/shared/media.js';
import { ApiClient, type TestSuiteDto } from '../src/lib/api-client.js';

const FILE = '/attachments/files/0f8fad5b-d9cb-469f-a165-70867728950e';

beforeEach(() => {
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => true) });
});
afterEach(() => vi.restoreAllMocks());

describe('sanitizeRichText images', () => {
  it('keeps a safe image without alt text', () => {
    expect(sanitizeRichText('<p>a</p><img src="https://x.test/a.png">')).toBe(
      '<p>a</p><img src="https://x.test/a.png" alt="">',
    );
  });
});

describe('TestCaseModal attachments and saving', () => {
  const testCase: TestCase = {
    id: 'CT-09',
    title: 'Upload',
    scenario: '<p>Scenario</p>',
    steps: [],
    metadata: {
      attachments: [
        null,
        { id: 'bad' },
        { id: 'img-1', name: 'shot.png', kind: 'image', url: FILE, scope: 'testcase' },
      ],
    },
  };

  function modal(onSave = vi.fn()) {
    const apiClient = new ApiClient({ baseUrl: 'http://api.test' });
    vi.spyOn(apiClient, 'getMedia').mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    URL.createObjectURL = vi.fn(() => 'blob:x');
    const ui = render(
      <MediaProvider apiClient={apiClient}>
        <TestCaseModal testCase={testCase} onSave={onSave} onClose={vi.fn()} />
      </MediaProvider>,
    );
    return { ui, onSave };
  }

  it('inserts an attachment in the scenario, removes it and saves through the media client', async () => {
    const { ui, onSave } = modal();
    expect(ui.getByText('shot.png')).toBeInTheDocument();
    fireEvent.click(ui.getByRole('button', { name: 'Inserir no texto: shot.png' }));
    expect(ui.getByTestId('input-edit-test-scenario').querySelector('img')).not.toBeNull();
    fireEvent.click(ui.getByRole('button', { name: 'Remover anexo: shot.png' }));
    expect(ui.queryByText('shot.png')).toBeNull();
    fireEvent.click(ui.getByTestId('btn-save-test-case-modal'));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const saved = onSave.mock.calls[0]![0] as TestCase;
    expect(saved.scenario).toContain(`<img src="${FILE}"`);
    expect(saved.metadata?.['attachments']).toEqual([]);
  });

  it('shows the save failure, from an Error or any other value', async () => {
    const first = modal(
      vi.fn(() => {
        throw new Error('disk full');
      }),
    );
    fireEvent.click(first.ui.getByTestId('btn-save-test-case-modal'));
    expect(await first.ui.findByRole('alert')).toHaveTextContent('disk full');
    first.ui.unmount();

    const second = modal(
      vi.fn(() => {
        throw 'offline';
      }),
    );
    fireEvent.click(second.ui.getByTestId('btn-save-test-case-modal'));
    expect(await second.ui.findByRole('alert')).toHaveTextContent('offline');
  });
});

describe('TestCaseModal without metadata', () => {
  it('adds a URL attachment and reports images too large to drop', async () => {
    const apiClient = new ApiClient({ baseUrl: 'http://api.test' });
    const ui = render(
      <MediaProvider apiClient={apiClient}>
        <TestCaseModal
          testCase={{ id: 'CT-10', title: 'Bare', scenario: '' }}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />
      </MediaProvider>,
    );
    fireEvent.change(ui.getByLabelText('URL do arquivo'), {
      target: { value: 'https://x.test/doc.pdf' },
    });
    fireEvent.click(ui.getByRole('button', { name: 'Adicionar URL' }));
    expect(ui.getByText('doc.pdf')).toBeInTheDocument();

    const big = new File(['x'], 'big.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: 50 * 1024 * 1024 });
    fireEvent.drop(ui.getByTestId('input-edit-test-scenario'), {
      dataTransfer: { files: [big] },
    });
    expect(await ui.findByRole('alert')).toHaveTextContent('big.png');
  });
});

describe('PublishTestSuiteModal loading and destinations', () => {
  const suite = { id: 'suite-1', name: 'Regression' } as TestSuiteDto;

  function client() {
    return {
      getTestSuiteProviders: vi.fn().mockResolvedValue([
        { id: 'azure_devops', name: 'Azure DevOps', configured: true },
        { id: 'testrail', name: 'TestRail', configured: false },
      ]),
      getRemoteTestPlans: vi.fn().mockResolvedValue([{ id: '7', name: 'Plan' }]),
      getRemoteTestSuites: vi.fn().mockResolvedValue([]),
      previewTestSuiteFields: vi.fn().mockResolvedValue({ count: 0, previews: [] }),
      getPbiItems: vi
        .fn()
        .mockResolvedValue([item('p1', 'Cores', 5, '50'), item('p2', 'Cores again', 'Bug', '50')]),
    };
  }

  function item(id: string, title: string, type: unknown, externalId: string) {
    return {
      id,
      title,
      status: 'New',
      sourceData: { type },
      links: [{ providerId: 'azure_devops', externalId }],
    };
  }

  function open(api: Record<string, unknown>, onPublish = vi.fn()) {
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

  it('lists unconfigured providers and explains when none is configured', async () => {
    const api = client();
    api.getTestSuiteProviders.mockResolvedValue([
      { id: 'testrail', name: 'TestRail', configured: false },
    ]);
    const dialog = open(api);
    expect(
      await within(dialog).findByText('Configure uma integração de testes antes de publicar.'),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('option', { name: 'TestRail — Não configurado' }),
    ).toHaveProperty('disabled', true);
  });

  it('shows provider load failures and retries', async () => {
    const api = client();
    api.getTestSuiteProviders.mockRejectedValueOnce(new Error('down')).mockRejectedValueOnce('x');
    const dialog = open(api);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('down');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        'Não foi possível carregar os destinos.',
      ),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tentar novamente' }));
    expect(await within(dialog).findByLabelText('Provedor')).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).queryByRole('alert')).toBeNull());
  });

  it('shows plan and suite load failures, and labels suites whose parent is missing', async () => {
    const api = client();
    api.getRemoteTestPlans
      .mockRejectedValueOnce(new Error('plans down'))
      .mockRejectedValueOnce('x');
    api.getRemoteTestSuites
      .mockRejectedValueOnce(new Error('suites down'))
      .mockRejectedValueOnce('y')
      .mockResolvedValue([
        { id: '11', name: 'Orphan', parentId: '99', suiteType: 'staticTestSuite' },
      ]);
    const dialog = open(api);
    fireEvent.change(await within(dialog).findByLabelText('Provedor'), {
      target: { value: 'azure_devops' },
    });
    fireEvent.change(within(dialog).getByLabelText('Destino'), { target: { value: 'existing' } });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('plans down');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        'Não foi possível carregar os destinos.',
      ),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tentar novamente' }));
    fireEvent.change(await within(dialog).findByLabelText('Test Plan de destino'), {
      target: { value: '7' },
    });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('suites down');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        'Não foi possível carregar os destinos.',
      ),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tentar novamente' }));
    expect(await within(dialog).findByRole('option', { name: /^Orphan/ })).toBeInTheDocument();
  });

  it('offers each board work item once and reports board and publish failures', async () => {
    const api = client();
    const onPublish = vi.fn().mockRejectedValue('nope');
    const dialog = open(api, onPublish);
    fireEvent.change(await within(dialog).findByLabelText('Provedor'), {
      target: { value: 'azure_devops' },
    });
    fireEvent.focus(
      await within(dialog).findByRole('combobox', { name: 'Work items vinculados (opcional)' }),
    );
    expect(
      within(within(dialog).getByRole('listbox'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['#50 · CoresNew']);
    const publish = within(dialog).getByRole('button', { name: 'Publicar suite' });
    await waitFor(() => expect(publish).toHaveProperty('disabled', false));
    fireEvent.click(publish);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Falha ao publicar a suite de testes.',
    );
  });

  it('offers the suite custom fields as template sources', async () => {
    const api = {
      ...client(),
      getTestSuiteFieldSources: vi
        .fn()
        .mockResolvedValue([{ providerId: 'azure_devops', key: 'Custom.Risk' }]),
      getFieldMappingTemplates: vi.fn().mockResolvedValue([
        {
          id: 'tpl-1',
          workspaceId: 'ws',
          name: 'Riscos',
          entityType: 'test_case',
          providerId: 'azure_devops',
          scope: '',
          itemType: 'Test Case',
          createdAt: '',
          updatedAt: '',
          rules: [
            {
              targetFieldId: 'Custom.Area',
              source: { kind: 'custom', providerId: 'azure_devops', key: 'Custom.Risk' },
            },
          ],
        },
      ]),
      getTestCaseFieldCatalog: vi
        .fn()
        .mockResolvedValue([{ id: 'Custom.Area', name: 'Área', type: 'text' }]),
    };
    const dialog = open(api);
    fireEvent.change(await within(dialog).findByLabelText('Provedor'), {
      target: { value: 'azure_devops' },
    });
    const region = await within(dialog).findByRole('region', { name: 'Mapeamento de campos' });
    fireEvent.change(await within(region).findByRole('combobox', { name: 'Template salvo' }), {
      target: { value: 'tpl-1' },
    });
    expect(await within(region).findByRole('textbox', { name: /Área/ })).toHaveAttribute(
      'placeholder',
      'Usar origem: azure_devops · Custom.Risk',
    );
  });

  it('reports a board that cannot be loaded', async () => {
    const api = client();
    api.getPbiItems.mockRejectedValue('x');
    const dialog = open(api);
    fireEvent.change(await within(dialog).findByLabelText('Provedor'), {
      target: { value: 'azure_devops' },
    });
    expect(
      await within(dialog).findByText('Não foi possível carregar os itens do board.'),
    ).toBeInTheDocument();
  });
});
