import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SpecView } from '../src/features/spec/SpecView.js';
import { ApiClient } from '../src/lib/api-client.js';

const template = {
  id: 't1',
  workspaceId: 'w1',
  name: 'Base',
  sections: [{ id: 'objective', title: 'Objetivo', required: true }],
  createdAt: '',
  updatedAt: '',
};
const spec = {
  id: 's1',
  workspaceId: 'w1',
  templateId: 't1',
  title: 'Login',
  sections: [{ templateSectionId: 'objective', title: 'Objetivo', content: 'Permitir acesso' }],
  messages: [],
  createdAt: '',
  updatedAt: '',
};
const other = { ...spec, id: 's2', title: 'Cadastro' };

function client() {
  const api = new ApiClient();
  vi.spyOn(api, 'getSpecTemplates').mockResolvedValue([template]);
  vi.spyOn(api, 'getSpecifications').mockResolvedValue([spec, other]);
  vi.spyOn(api, 'getAgents').mockResolvedValue([]);
  return api;
}

describe('SpecView coverage (Vitest 5)', () => {
  it('keeps the newly selected Spec when an earlier deletion finishes', async () => {
    const api = client();
    let finish!: () => void;
    vi.spyOn(api, 'deleteSpecification').mockReturnValue(
      new Promise<void>((resolve) => (finish = resolve)),
    );
    const view = render(<SpecView apiClient={api} activeWorkspaceId="w1" />);
    fireEvent.click(await view.findByRole('button', { name: 'Login' }));
    fireEvent.click(view.getByRole('button', { name: 'Ações' }));
    fireEvent.click(view.getByRole('button', { name: 'Excluir' }));
    fireEvent.click(within(view.getByRole('alertdialog')).getByRole('button', { name: 'Excluir' }));
    fireEvent.click(view.getByRole('button', { name: 'Cadastro' }));
    await act(async () => finish());
    expect(view.queryByRole('button', { name: 'Login' })).toBeNull();
    expect(view.getByDisplayValue('Cadastro')).toBeInTheDocument();
  });

  it('switches to a new template from the template picker', async () => {
    const view = render(<SpecView apiClient={client()} activeWorkspaceId="w1" />);
    await view.findByRole('button', { name: 'Login' });
    fireEvent.click(view.getByRole('button', { name: 'Configurações' }));
    const picker = view.getByRole('combobox', { name: 'Template para editar' });
    expect(picker).toHaveProperty('value', 't1');
    fireEvent.change(picker, { target: { value: '' } });
    expect(picker).toHaveProperty('value', '');
    fireEvent.click(view.getByRole('button', { name: 'Ações' }));
    expect(view.queryByRole('button', { name: 'Excluir template' })).toBeNull();
    fireEvent.change(picker, { target: { value: 't1' } });
    await waitFor(() => expect(picker).toHaveProperty('value', 't1'));
  });
});
