import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { E2eEnvironments } from '../src/features/e2e/E2eEnvironments.js';
import { E2eImage } from '../src/features/e2e/E2eImage.js';
import { E2eConfigForm } from '../src/features/e2e/E2eConfigForm.js';
import type { ApiClient } from '../src/lib/api-client.js';
import type { E2eEnvironment } from '../src/features/e2e/e2e-types.js';

const staging: E2eEnvironment = {
  id: 'env1',
  name: 'Staging',
  baseUrl: 'https://staging.example.com',
  username: 'qa@example.com',
  hasPassword: true,
  isDefault: true,
  variableNames: ['PLAN'],
};
const local: E2eEnvironment = {
  id: 'env2',
  name: 'Local',
  baseUrl: 'http://localhost:3000',
  username: null,
  hasPassword: false,
  isDefault: false,
  variableNames: [],
};

function api(list: readonly E2eEnvironment[] | Error = [staging, local]) {
  return {
    getE2eEnvironments: vi.fn(() =>
      list instanceof Error ? Promise.reject(list) : Promise.resolve(list),
    ),
    saveE2eEnvironment: vi.fn().mockResolvedValue(staging),
    deleteE2eEnvironment: vi.fn().mockResolvedValue(undefined),
  };
}
const asClient = (client: object) => client as unknown as ApiClient;

describe('E2eEnvironments', () => {
  it('lists the environments, marks the default and goes back', async () => {
    const onBack = vi.fn();
    const view = render(<E2eEnvironments apiClient={asClient(api())} onBack={onBack} />);
    expect(view.container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    expect(await view.findByText('Staging')).toBeInTheDocument();
    expect(view.getByText('Padrão')).toBeInTheDocument();
    expect(view.getByText('https://staging.example.com · qa@example.com')).toBeInTheDocument();
    expect(view.getByText('http://localhost:3000')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: /Voltar/ }));
    expect(onBack).toHaveBeenCalled();
  });

  it('shows the empty state, and a load error that can be retried', async () => {
    const empty = render(<E2eEnvironments apiClient={asClient(api([]))} onBack={vi.fn()} />);
    expect(await empty.findByText(/Nenhum ambiente ainda/)).toBeInTheDocument();
    empty.unmount();

    const client = api(new Error('offline'));
    const view = render(<E2eEnvironments apiClient={asClient(client)} onBack={vi.fn()} />);
    expect(await view.findByText('offline')).toBeInTheDocument();
    client.getE2eEnvironments.mockRejectedValueOnce('no reason');
    fireEvent.click(view.getByRole('button', { name: 'Tentar novamente' }));
    expect(
      await view.findByText('Não foi possível carregar as execuções E2E.'),
    ).toBeInTheDocument();
    client.getE2eEnvironments.mockResolvedValue([local]);
    fireEvent.click(view.getByRole('button', { name: 'Tentar novamente' }));
    expect(await view.findByText('Local')).toBeInTheDocument();
  });

  it('only lets members who can edit add or open environments', async () => {
    const view = render(
      <E2eEnvironments apiClient={asClient(api())} isReadOnly onBack={vi.fn()} />,
    );
    await view.findByText('Staging');
    expect(view.queryByRole('button', { name: /Adicionar ambiente/ })).toBeNull();
    expect(view.getByRole('button', { name: 'Abrir ambiente Staging' })).toHaveAttribute(
      'disabled',
    );
  });

  it('adds an environment with an account and custom variables', async () => {
    const client = api([]);
    const view = render(<E2eEnvironments apiClient={asClient(client)} onBack={vi.fn()} />);
    await view.findByText(/Nenhum ambiente ainda/);
    fireEvent.click(view.getByRole('button', { name: /Adicionar ambiente/ }));
    const dialog = view.getByRole('dialog');
    expect(dialog).toHaveTextContent('Adicionar ambiente');
    expect(view.queryByRole('button', { name: /Excluir/ })).toBeNull();
    expect(view.queryByText('Senha definida')).toBeNull();

    fireEvent.change(view.getByLabelText('Nome'), { target: { value: ' Staging ' } });
    fireEvent.change(view.getByLabelText('URL do site'), {
      target: { value: 'https://staging.example.com' },
    });
    fireEvent.change(view.getByLabelText('Usuário da conta de teste'), {
      target: { value: ' qa@example.com ' },
    });
    fireEvent.change(view.getByLabelText('Senha da conta de teste'), { target: { value: 'pw' } });
    fireEvent.click(view.getByRole('button', { name: /Adicionar variável/ }));
    fireEvent.click(view.getByRole('button', { name: /Adicionar variável/ }));
    fireEvent.click(view.getByRole('button', { name: /Adicionar variável/ }));
    const names = view.getAllByLabelText('Nome da variável');
    const values = view.getAllByLabelText('Valor');
    fireEvent.change(names[0]!, { target: { value: ' plan ' } });
    fireEvent.change(values[0]!, { target: { value: 'premium' } });
    fireEvent.change(names[1]!, { target: { value: 'gone' } });
    // The second one is removed, the third stays blank and is left out.
    fireEvent.click(view.getByRole('button', { name: 'Remover variável gone' }));
    expect(view.getByRole('button', { name: 'Remover variável 2' })).toBeInTheDocument();

    client.getE2eEnvironments.mockResolvedValue([staging]);
    fireEvent.click(view.getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(client.saveE2eEnvironment).toHaveBeenCalledWith(
        {
          name: 'Staging',
          baseUrl: 'https://staging.example.com',
          username: 'qa@example.com',
          password: 'pw',
          variables: [{ key: 'plan', value: 'premium' }],
        },
        undefined,
      ),
    );
    expect(await view.findByRole('button', { name: 'Abrir ambiente Staging' })).toBeInTheDocument();
    expect(view.queryByRole('dialog')).toBeNull();
  });

  it('edits an environment keeping the saved password and variable values', async () => {
    const client = api();
    const view = render(<E2eEnvironments apiClient={asClient(client)} onBack={vi.fn()} />);
    fireEvent.click(await view.findByRole('button', { name: 'Abrir ambiente Staging' }));
    expect(view.getByRole('dialog')).toHaveTextContent('Editar ambiente');
    expect(view.getByText('Senha definida')).toBeInTheDocument();
    expect(view.getByPlaceholderText('Deixe vazio para manter a senha salva')).toBeInTheDocument();
    expect(view.getByPlaceholderText('Salvo (digite para substituir)')).toBeInTheDocument();

    // Cancel closes without saving.
    fireEvent.click(view.getByRole('button', { name: 'Cancelar' }));
    expect(view.queryByRole('dialog')).toBeNull();
    expect(client.saveE2eEnvironment).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole('button', { name: 'Abrir ambiente Staging' }));
    fireEvent.change(view.getByLabelText('Usuário da conta de teste'), { target: { value: '' } });
    fireEvent.click(view.getByRole('button', { name: /Adicionar variável/ }));
    fireEvent.change(view.getAllByLabelText('Nome da variável')[1]!, {
      target: { value: 'REGION' },
    });
    fireEvent.change(view.getAllByLabelText('Valor')[1]!, { target: { value: 'eu' } });
    fireEvent.click(view.getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(client.saveE2eEnvironment).toHaveBeenCalledWith(
        {
          name: 'Staging',
          baseUrl: 'https://staging.example.com',
          // The saved variable goes without a value, so the server keeps it.
          variables: [{ key: 'PLAN' }, { key: 'REGION', value: 'eu' }],
        },
        'env1',
      ),
    );

    // A saved variable that gets a new value, or a new name, is sent whole.
    fireEvent.click(await view.findByRole('button', { name: 'Abrir ambiente Staging' }));
    fireEvent.change(view.getByLabelText('Valor'), { target: { value: 'basic' } });
    fireEvent.click(view.getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(client.saveE2eEnvironment.mock.lastCall![0].variables).toEqual([
        { key: 'PLAN', value: 'basic' },
      ]),
    );
    fireEvent.click(await view.findByRole('button', { name: 'Abrir ambiente Staging' }));
    fireEvent.change(view.getByLabelText('Nome da variável'), { target: { value: 'TIER' } });
    fireEvent.click(view.getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(client.saveE2eEnvironment.mock.lastCall![0].variables).toEqual([
        { key: 'TIER', value: '' },
      ]),
    );
  });

  it('reports a failed save and deletes after confirmation', async () => {
    const client = api();
    client.saveE2eEnvironment.mockRejectedValueOnce(new Error('URL inválida'));
    const view = render(<E2eEnvironments apiClient={asClient(client)} onBack={vi.fn()} />);
    fireEvent.click(await view.findByRole('button', { name: 'Abrir ambiente Staging' }));
    fireEvent.click(view.getByRole('button', { name: 'Salvar' }));
    expect(await view.findByRole('alert')).toHaveTextContent('URL inválida');

    fireEvent.click(view.getByRole('button', { name: /Excluir/ }));
    expect(view.getByRole('alertdialog')).toHaveTextContent('Excluir "Staging"?');
    fireEvent.click(view.getByRole('button', { name: 'Cancelar' }));
    expect(view.getByRole('dialog')).toHaveTextContent('Editar ambiente');

    client.deleteE2eEnvironment.mockRejectedValueOnce('nope');
    fireEvent.click(view.getByRole('button', { name: /Excluir/ }));
    fireEvent.click(view.getByRole('button', { name: 'Excluir' }));
    expect(await view.findByRole('alert')).toHaveTextContent('Não foi possível concluir a ação.');

    client.getE2eEnvironments.mockResolvedValue([local]);
    fireEvent.click(view.getByRole('button', { name: /Excluir/ }));
    fireEvent.click(view.getByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(client.deleteE2eEnvironment).toHaveBeenLastCalledWith('env1'));
    await waitFor(() => expect(view.queryByText('Staging')).toBeNull());
    expect(view.queryByRole('alertdialog')).toBeNull();
  });
});

describe('E2eImage', () => {
  const create = vi.fn((blob: Blob) => `blob:${blob.size}`);
  const revoke = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
  });
  afterEach(() => {
    create.mockClear();
    revoke.mockClear();
  });

  it('downloads the image, replaces it on a new version and frees it', async () => {
    const getE2eImage = vi.fn().mockResolvedValue(new Blob(['a']));
    const client = asClient({ getE2eImage });
    const view = render(
      <E2eImage apiClient={client} path="tests/t1/live" version={1} alt="Live" />,
    );
    expect(view.queryByRole('img')).toBeNull();
    const image = await view.findByAltText('Live');
    expect(image).toHaveAttribute('src', 'blob:1');
    expect(getE2eImage).toHaveBeenCalledWith('tests/t1/live', expect.any(AbortSignal));

    getE2eImage.mockResolvedValue(new Blob(['abc']));
    view.rerender(<E2eImage apiClient={client} path="tests/t1/live" version={2} alt="Live" />);
    await waitFor(() => expect(view.getByAltText('Live')).toHaveAttribute('src', 'blob:3'));
    expect(revoke).toHaveBeenCalledWith('blob:1');

    // A frame that fails to load keeps the last picture on screen.
    getE2eImage.mockRejectedValue(new Error('gone'));
    view.rerender(<E2eImage apiClient={client} path="tests/t1/live" version={3} alt="Live" />);
    await waitFor(() => expect(getE2eImage).toHaveBeenCalledTimes(3));
    expect(view.getByAltText('Live')).toHaveAttribute('src', 'blob:3');

    view.unmount();
    expect(revoke).toHaveBeenLastCalledWith('blob:3');
  });

  it('shows a mark, or the given fallback, when there is no picture', async () => {
    const client = asClient({ getE2eImage: vi.fn().mockRejectedValue(new Error('missing')) });
    const plain = render(<E2eImage apiClient={client} path="x" alt="Página" />);
    expect(await plain.findByRole('img', { name: 'Página' })).toBeInTheDocument();
    plain.unmount();
    expect(revoke).not.toHaveBeenCalled();

    const view = render(<E2eImage apiClient={client} path="x" alt="Página" fallback="Abrindo" />);
    expect(await view.findByText('Abrindo')).toBeInTheDocument();
  });

  it('ignores an image that arrives or fails after it was replaced', async () => {
    let resolve!: (blob: Blob) => void;
    let reject!: (error: Error) => void;
    const getE2eImage = vi
      .fn()
      .mockReturnValueOnce(new Promise<Blob>((done) => (resolve = done)))
      .mockReturnValueOnce(new Promise<Blob>((_, fail) => (reject = fail)))
      .mockResolvedValue(new Blob(['ok']));
    const client = asClient({ getE2eImage });
    const view = render(<E2eImage apiClient={client} path="a" alt="Live" />);
    view.rerender(<E2eImage apiClient={client} path="b" alt="Live" />);
    view.rerender(<E2eImage apiClient={client} path="c" alt="Live" />);
    await act(async () => {
      resolve(new Blob(['late']));
      reject(new Error('late'));
    });
    expect(await view.findByAltText('Live')).toHaveAttribute('src', 'blob:2');
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('E2eConfigForm environments', () => {
  function formApi(environments: readonly E2eEnvironment[] | Error) {
    return {
      getAgents: vi.fn().mockResolvedValue([{ id: 'a1', name: 'QA', role: 'QA' }]),
      getE2eRepositories: vi.fn().mockResolvedValue({
        repositories: [{ id: '42', provider: 'github', name: 'acme/app', defaultBranch: 'main' }],
        warnings: [],
      }),
      getE2eBranches: vi.fn().mockResolvedValue([{ name: 'main', isDefault: true }]),
      getE2eEnvironments: vi.fn(() =>
        environments instanceof Error
          ? Promise.reject(environments)
          : Promise.resolve(environments),
      ),
      createE2eCreation: vi.fn().mockResolvedValue({ id: 'c1', name: 'run' }),
      updateE2eCreation: vi.fn().mockResolvedValue({ id: 'c1', name: 'run' }),
      getE2eCreation: vi.fn(),
    };
  }

  async function fillRequired(view: ReturnType<typeof render>) {
    await waitFor(() =>
      expect((view.getByLabelText('Agente') as HTMLSelectElement).value).toBe('a1'),
    );
    fireEvent.change(view.getByLabelText('Nome da execução'), { target: { value: 'run' } });
    fireEvent.change(view.getByLabelText('Ou cole o conteúdo'), { target: { value: 'PRD' } });
    await waitFor(() =>
      expect(view.getByLabelText('Repositório').querySelectorAll('option').length).toBe(2),
    );
    fireEvent.change(view.getByLabelText('Repositório'), { target: { value: 'github:42' } });
    await waitFor(() =>
      expect((view.getByLabelText('Branch base') as HTMLSelectElement).value).toBe('main'),
    );
  }

  it('fills the address and the account from the chosen environment and links the run', async () => {
    const client = formApi([staging, local]);
    const view = render(
      <E2eConfigForm apiClient={asClient(client)} onCancel={vi.fn()} onCreated={vi.fn()} />,
    );
    await fillRequired(view);
    fireEvent.change(view.getByLabelText('Senha da conta de teste'), {
      target: { value: 'typed' },
    });
    fireEvent.change(await view.findByLabelText('Ambiente'), { target: { value: 'env1' } });
    expect((view.getByLabelText('URL base') as HTMLInputElement).value).toBe(
      'https://staging.example.com',
    );
    expect((view.getByLabelText('Usuário da conta de teste') as HTMLInputElement).value).toBe(
      'qa@example.com',
    );
    // The environment brings its own password.
    expect((view.getByLabelText('Senha da conta de teste') as HTMLInputElement).value).toBe('');

    // An environment without an account clears it; "none" keeps what is on the form.
    fireEvent.change(view.getByLabelText('Ambiente'), { target: { value: 'env2' } });
    expect((view.getByLabelText('Usuário da conta de teste') as HTMLInputElement).value).toBe('');
    fireEvent.change(view.getByLabelText('Ambiente'), { target: { value: '' } });
    expect((view.getByLabelText('URL base') as HTMLInputElement).value).toBe(
      'http://localhost:3000',
    );

    fireEvent.change(view.getByLabelText('Ambiente'), { target: { value: 'env1' } });
    fireEvent.click(view.getByRole('button', { name: 'Continuar' }));
    await waitFor(() => expect(client.createE2eCreation).toHaveBeenCalled());
    expect(client.createE2eCreation.mock.calls[0]![0]).toMatchObject({
      environmentId: 'env1',
      baseUrl: 'https://staging.example.com',
      username: 'qa@example.com',
    });
  });

  it('offers no environment when there is none or they cannot be loaded', async () => {
    for (const environments of [[], new Error('offline')]) {
      const client = formApi(environments);
      const view = render(
        <E2eConfigForm apiClient={asClient(client)} onCancel={vi.fn()} onCreated={vi.fn()} />,
      );
      await fillRequired(view);
      expect(view.queryByLabelText('Ambiente')).toBeNull();
      fireEvent.change(view.getByLabelText('URL base'), { target: { value: 'https://x.test' } });
      fireEvent.click(view.getByRole('button', { name: 'Continuar' }));
      await waitFor(() => expect(client.createE2eCreation).toHaveBeenCalled());
      expect(client.createE2eCreation.mock.calls[0]![0]).not.toHaveProperty('environmentId');
      view.unmount();
    }
  });

  it('unlinks an edited run from its environment', async () => {
    const client = formApi([staging]);
    client.getE2eCreation.mockResolvedValue({
      id: 'c1',
      agentId: 'a1',
      name: 'run',
      mode: 'frontend',
      scope: 'codebase',
      baseUrl: 'https://staging.example.com',
      path: '/',
      username: 'qa@example.com',
      hasPassword: true,
      environmentId: 'env1',
      prdFileNames: [],
      repository: { provider: 'github', id: '42', name: 'acme/app', branch: 'main', path: 't' },
      reporting: null,
      lastReport: null,
      status: 'completed',
      error: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      finishedAt: null,
      tests: [],
      prd: 'PRD',
      diff: null,
      instructions: null,
    });
    const view = render(
      <E2eConfigForm
        apiClient={asClient(client)}
        creationId="c1"
        onCancel={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect((view.getByLabelText('Ambiente') as HTMLSelectElement).value).toBe('env1'),
    );
    fireEvent.change(view.getByLabelText('Ambiente'), { target: { value: '' } });
    await waitFor(() =>
      expect((view.getByLabelText('Branch base') as HTMLSelectElement).value).toBe('main'),
    );
    fireEvent.click(view.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(client.updateE2eCreation).toHaveBeenCalled());
    expect(client.updateE2eCreation.mock.calls[0]![1]).toMatchObject({ environmentId: null });
  });
});
