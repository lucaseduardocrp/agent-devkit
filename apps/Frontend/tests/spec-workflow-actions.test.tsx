import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient, type SpecificationDto } from '../src/lib/api-client.js';
import { SpecWorkflowAction } from '../src/features/spec/SpecWorkflowAction.js';
import { CreateSpecFromDocument } from '../src/features/brain/CreateSpecFromDocument.js';
import type { CustomAgentDto } from '../src/features/agents/agent-types.js';

const spec: SpecificationDto = {
  id: 's',
  workspaceId: 'w',
  title: 'Generated',
  sections: [],
  messages: [],
  createdAt: '',
  updatedAt: '',
};
const document = {
  id: 'd',
  pageId: 'd',
  source: 'wiki',
  title: 'Source',
  chunksCount: 1,
  totalCharacters: 4,
  updatedAt: '',
};
const agent = { id: 'writer', name: 'Writer' } as CustomAgentDto;

describe('Spec workflow actions', () => {
  it('requires confirmation to clear persisted context and supports failure and retry', async () => {
    const client = new ApiClient();
    const clear = vi
      .spyOn(client, 'clearSpecificationMessages')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(spec);
    const onCleared = vi.fn();
    const view = render(
      <SpecWorkflowAction
        apiClient={client}
        spec={spec}
        action="clear"
        disabled={false}
        onCleared={onCleared}
      />,
    );
    fireEvent.click(view.getByRole('button', { name: 'Limpar contexto' }));
    fireEvent.click(
      within(view.getByRole('alertdialog')).getByRole('button', { name: 'Cancelar' }),
    );
    expect(clear).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: 'Limpar contexto' }));
    fireEvent.click(
      within(view.getByRole('alertdialog')).getByRole('button', { name: 'Confirmar' }),
    );
    expect(await view.findByRole('alert')).toHaveTextContent('offline');
    expect(onCleared).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: 'Limpar contexto' }));
    fireEvent.click(
      within(view.getByRole('alertdialog')).getByRole('button', { name: 'Confirmar' }),
    );
    expect(await view.findByRole('status')).toHaveTextContent('Mensagens apagadas');
    expect(onCleared).toHaveBeenCalledWith(spec);
    expect(clear).toHaveBeenCalledWith('s');
  });

  it('publishes without confirmation, handles non-Error failures and disables pending actions', async () => {
    const client = new ApiClient();
    const publish = vi
      .spyOn(client, 'publishSpecification')
      .mockRejectedValueOnce('offline')
      .mockResolvedValue({ pageId: 'p', source: 'app://local', title: 'Spec' });
    const view = render(
      <SpecWorkflowAction
        apiClient={client}
        spec={spec}
        action="publish"
        disabled={false}
        onCleared={vi.fn()}
      />,
    );
    fireEvent.click(view.getByRole('button', { name: 'Criar documento no Brain' }));
    expect((view.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    expect(await view.findByRole('alert')).toHaveTextContent('Não foi possível');
    fireEvent.click(view.getByRole('button', { name: 'Criar documento no Brain' }));
    expect(await view.findByRole('status')).toHaveTextContent('Documento salvo no Brain');
    expect(publish).toHaveBeenCalledWith('s');
  });
});

describe('Brain Spec generation', () => {
  it('requires explicit agent selection, supports failed generation retry and reports the saved Spec', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getAgents').mockResolvedValue([agent]);
    const generate = vi
      .spyOn(client, 'createSpecificationFromKnowledge')
      .mockRejectedValueOnce(new Error('Model offline'))
      .mockResolvedValue(spec);
    const view = render(<CreateSpecFromDocument apiClient={client} document={document} />);
    fireEvent.click(view.getByRole('button', { name: 'Criar Spec com Agent' }));
    expect(view.getByRole('status')).toHaveTextContent('Carregando');
    const select = await view.findByRole('combobox');
    expect((view.getByRole('button', { name: 'Confirmar' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(select, { target: { value: 'writer' } });
    fireEvent.click(view.getByRole('button', { name: 'Confirmar' }));
    expect(await view.findByRole('alert')).toHaveTextContent('Model offline');
    expect(view.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Confirmar' }));
    await waitFor(() => expect(view.queryByRole('dialog')).not.toBeInTheDocument());
    expect(view.getByRole('status')).toHaveTextContent('Generated');
    expect(generate).toHaveBeenCalledWith({
      pageId: 'd',
      source: 'wiki',
      title: 'Source',
      agentId: 'writer',
    });
  });

  it('handles missing agents, load failure, cancel and retry without creating a Spec', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getAgents')
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce('offline')
      .mockResolvedValue([agent]);
    const generate = vi.spyOn(client, 'createSpecificationFromKnowledge');
    const view = render(<CreateSpecFromDocument apiClient={client} document={document} />);
    fireEvent.click(view.getByRole('button', { name: 'Criar Spec com Agent' }));
    expect(await view.findByText(/Nenhum agente disponível/)).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Cancelar' }));
    expect(view.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Criar Spec com Agent' }));
    expect(await view.findByRole('alert')).toHaveTextContent('Não foi possível');
    fireEvent.click(view.getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(view.getByRole('button', { name: 'Criar Spec com Agent' }));
    expect(await view.findByRole('option', { name: 'Writer' })).toBeInTheDocument();
    expect(generate).not.toHaveBeenCalled();
  });
});

it('uses the new API routes with encoded IDs and expected payloads', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => spec } as Response);
  const client = new ApiClient({ fetcher });
  await client.clearSpecificationMessages('s/1');
  expect(fetcher).toHaveBeenLastCalledWith(
    expect.stringContaining('/spec/specifications/s%2F1/messages'),
    expect.objectContaining({ method: 'DELETE' }),
  );
  await client.publishSpecification('s/1');
  expect(fetcher).toHaveBeenLastCalledWith(
    expect.stringContaining('/spec/specifications/s%2F1/knowledge'),
    expect.objectContaining({ method: 'POST' }),
  );
  const input = { pageId: 'd', source: 'wiki', title: 'Title', agentId: 'writer' };
  await client.createSpecificationFromKnowledge(input);
  expect(fetcher).toHaveBeenLastCalledWith(
    expect.stringContaining('/spec/from-knowledge'),
    expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }),
  );
});
