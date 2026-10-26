import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpecView } from '../src/features/spec/SpecView.js';
import { MediaProvider } from '../src/features/shared/media.js';
import { ApiClient, type SpecificationDto } from '../src/lib/api-client.js';

const template = {
  id: 't1',
  workspaceId: 'w1',
  name: 'Base',
  sections: [{ id: 'objective', title: 'Objetivo', required: true }],
  createdAt: '',
  updatedAt: '',
};
const spec: SpecificationDto = {
  id: 's1',
  workspaceId: 'w1',
  templateId: 't1',
  title: 'Login',
  sections: [{ templateSectionId: 'objective', title: 'Objetivo', content: 'Permitir acesso' }],
  messages: [],
  createdAt: '',
  updatedAt: '',
};

function client(specs: SpecificationDto[] = []) {
  const apiClient = new ApiClient();
  vi.spyOn(apiClient, 'getSpecTemplates').mockResolvedValue([template]);
  vi.spyOn(apiClient, 'getSpecifications').mockResolvedValue(specs);
  vi.spyOn(apiClient, 'getAgents').mockResolvedValue([]);
  return apiClient;
}

afterEach(() => vi.restoreAllMocks());

describe('SpecView gaps', () => {
  it('leaves new Specs without a template after deleting the only one in use', async () => {
    const apiClient = client();
    vi.spyOn(apiClient, 'deleteSpecTemplate').mockResolvedValue();
    const save = vi
      .spyOn(apiClient, 'saveSpecification')
      .mockImplementation(async (input) => ({ ...spec, ...input, id: 's-new' }));
    render(<SpecView apiClient={apiClient} activeWorkspaceId="w1" canManageTemplates />);
    await screen.findByRole('heading', { name: 'Nova especificação' });

    fireEvent.click(screen.getByRole('button', { name: 'Configurações' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ações' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excluir template' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Excluir' }),
    );
    expect(await screen.findByText('Template excluído com sucesso.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Criar nova' }));
    expect(screen.getByLabelText<HTMLSelectElement>('Template').value).toBe('');
    fireEvent.change(screen.getByLabelText('Título'), { target: { value: 'Checkout' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar especificação' }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]![0]).toMatchObject({ title: 'Checkout', templateId: undefined });
  });

  it('saves a link attached while editing a Specification', async () => {
    const apiClient = client([spec]);
    const save = vi
      .spyOn(apiClient, 'saveSpecification')
      .mockImplementation(async (input) => ({ ...spec, ...input }));
    render(
      <MediaProvider apiClient={apiClient}>
        <SpecView apiClient={apiClient} activeWorkspaceId="w1" />
      </MediaProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Login' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ações' }));
    fireEvent.click(screen.getByRole('button', { name: 'Editar' }));

    fireEvent.change(screen.getByLabelText('URL do arquivo'), {
      target: { value: 'https://example.com/docs/fluxo.pdf' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar URL' }));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar especificação' }));

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]![0].attachments).toEqual([
      expect.objectContaining({ name: 'fluxo.pdf', url: 'https://example.com/docs/fluxo.pdf' }),
    ]);
  });

  it('moves new Specs to the next template after deleting the one in use', async () => {
    const apiClient = client();
    vi.mocked(apiClient.getSpecTemplates).mockResolvedValue([
      template,
      { ...template, id: 't2', name: 'Release' },
    ]);
    const remove = vi.spyOn(apiClient, 'deleteSpecTemplate').mockResolvedValue();
    render(<SpecView apiClient={apiClient} activeWorkspaceId="w1" canManageTemplates />);
    await screen.findByRole('heading', { name: 'Nova especificação' });
    expect(screen.getByLabelText<HTMLSelectElement>('Template').value).toBe('t1');

    fireEvent.click(screen.getByRole('button', { name: 'Configurações' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ações' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excluir template' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Excluir' }),
    );
    await waitFor(() => expect(remove).toHaveBeenCalledWith('t1'));
    expect(await screen.findByText('Template excluído com sucesso.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Criar nova' }));
    expect(screen.getByLabelText<HTMLSelectElement>('Template').value).toBe('t2');
  });
});
