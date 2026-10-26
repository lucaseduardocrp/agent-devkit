import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SpecView } from '../src/features/spec/SpecView.js';
import { ApiClient, type SpecTemplateDto, type SpecificationDto } from '../src/lib/api-client.js';

const base: SpecTemplateDto = {
  id: 't1',
  workspaceId: 'w1',
  name: 'Base',
  sections: [{ id: 'objective', title: 'Objetivo', required: true }],
  createdAt: '',
  updatedAt: '',
};
const release: SpecTemplateDto = {
  ...base,
  id: 't2',
  name: 'Release',
  sections: [{ id: 'scope', title: 'Escopo', required: true }],
};

function specification(id: string, title: string): SpecificationDto {
  return {
    id,
    workspaceId: 'w1',
    title,
    sections: [],
    messages: [],
    createdAt: '',
    updatedAt: '',
  };
}

function clientWith(templates: SpecTemplateDto[]) {
  const client = new ApiClient();
  vi.spyOn(client, 'getSpecTemplates').mockResolvedValue(templates);
  vi.spyOn(client, 'getSpecifications').mockResolvedValue([]);
  vi.spyOn(client, 'getAgents').mockResolvedValue([]);
  return client;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function openTemplateDeletion(view: ReturnType<typeof render>) {
  fireEvent.click(view.getByRole('button', { name: 'Ações' }));
  fireEvent.click(view.getByRole('button', { name: 'Excluir template' }));
  return view.getByRole('alertdialog');
}

describe('SpecView template deletion', () => {
  it('falls back to the remaining template after deleting one that is not used by the draft', async () => {
    const client = clientWith([base, release]);
    const remove = vi.spyOn(client, 'deleteSpecTemplate').mockResolvedValue();
    const view = render(<SpecView apiClient={client} activeWorkspaceId="w1" />);
    await view.findByRole('heading', { name: 'Nova especificação' });
    fireEvent.click(view.getByRole('button', { name: 'Configurações' }));
    fireEvent.change(view.getByLabelText('Template para editar'), { target: { value: 't2' } });
    expect((view.getByLabelText('Nome do template') as HTMLInputElement).value).toBe('Release');

    const dialog = await openTemplateDeletion(view);
    expect(dialog).toHaveTextContent('Release');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('t2'));
    expect(await view.findByText('Template excluído com sucesso.')).toBeInTheDocument();
    expect((view.getByLabelText('Nome do template') as HTMLInputElement).value).toBe('Base');
  });

  it('keeps the template when the deletion is cancelled or fails', async () => {
    const client = clientWith([base]);
    const remove = vi.spyOn(client, 'deleteSpecTemplate').mockRejectedValue('offline');
    const view = render(<SpecView apiClient={client} activeWorkspaceId="w1" />);
    await view.findByRole('heading', { name: 'Nova especificação' });
    fireEvent.click(view.getByRole('button', { name: 'Configurações' }));

    let dialog = await openTemplateDeletion(view);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(view.queryByRole('alertdialog')).toBeNull();
    expect(remove).not.toHaveBeenCalled();

    dialog = await openTemplateDeletion(view);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    expect(await view.findByRole('alert')).toHaveTextContent('Falha ao excluir template.');
    expect(remove).toHaveBeenCalledWith('t1');
    expect((view.getByLabelText('Nome do template') as HTMLInputElement).value).toBe('Base');
  });
});

describe('SpecView workspace switches', () => {
  it('ignores a slower load of the previous workspace', async () => {
    const client = new ApiClient();
    const first = deferred<SpecificationDto[]>();
    vi.spyOn(client, 'getSpecTemplates').mockResolvedValue([base]);
    vi.spyOn(client, 'getAgents').mockResolvedValue([]);
    vi.spyOn(client, 'getSpecifications')
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce([specification('s2', 'Checkout')]);
    const view = render(<SpecView apiClient={client} activeWorkspaceId="w1" />);
    view.rerender(<SpecView apiClient={client} activeWorkspaceId="w2" />);
    expect(await view.findByRole('button', { name: 'Checkout' })).toBeInTheDocument();

    first.resolve([specification('s1', 'Stale login')]);
    await first.promise;
    await waitFor(() => expect(view.queryByRole('button', { name: 'Stale login' })).toBeNull());
    expect(view.getByRole('button', { name: 'Checkout' })).toBeInTheDocument();
  });

  it('ignores a failure of the previous workspace load', async () => {
    const client = new ApiClient();
    const first = deferred<SpecificationDto[]>();
    vi.spyOn(client, 'getSpecTemplates').mockResolvedValue([base]);
    vi.spyOn(client, 'getAgents').mockResolvedValue([]);
    vi.spyOn(client, 'getSpecifications')
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce([specification('s2', 'Checkout')]);
    const view = render(<SpecView apiClient={client} activeWorkspaceId="w1" />);
    view.rerender(<SpecView apiClient={client} activeWorkspaceId="w2" />);
    expect(await view.findByRole('button', { name: 'Checkout' })).toBeInTheDocument();

    first.reject(new Error('Old workspace offline'));
    await first.promise.catch(() => undefined);
    await waitFor(() => expect(view.queryByRole('alert')).toBeNull());
    expect(view.queryByText('Old workspace offline')).toBeNull();
  });
});
