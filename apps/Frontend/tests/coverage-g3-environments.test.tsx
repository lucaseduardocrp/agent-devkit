import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiEnvironment } from '../src/features/apitests/api-test-types.js';
import { EnvironmentsPane } from '../src/features/apitests/integration/EnvironmentsPane.js';
import type { ApiClient } from '../src/lib/api-client.js';

const staging: ApiEnvironment = {
  id: 'e1',
  name: 'Staging',
  variables: [
    { key: 'token', value: '', secret: true, hasValue: true },
    { key: 'baseUrl', value: 'https://stg.test' },
  ],
  personalSecrets: ['var:token'],
};
const prod: ApiEnvironment = {
  id: 'e2',
  name: 'Production',
  variables: [{ key: 'baseUrl', value: 'https://prod.test' }],
};

function setup(
  props: Partial<React.ComponentProps<typeof EnvironmentsPane>> = {},
  api: Record<string, unknown> = {},
) {
  const client = {
    saveApiEnvironment: vi.fn((draft: { name: string; variables: unknown[] }) =>
      Promise.resolve({ id: 'saved', ...draft }),
    ),
    deleteApiEnvironment: vi.fn(() => Promise.resolve()),
    clearPersonalSecret: vi.fn(() => Promise.resolve()),
    ...api,
  };
  const onChanged = vi.fn();
  const onActivate = vi.fn();
  render(
    <EnvironmentsPane
      apiClient={client as unknown as ApiClient}
      environments={[staging, prod]}
      activeId=""
      readOnly={false}
      onChanged={onChanged}
      onActivate={onActivate}
      {...props}
    />,
  );
  return { client, onChanged, onActivate };
}

const name = () => screen.getByTestId<HTMLInputElement>('environment-name');
const confirmDelete = async () =>
  fireEvent.click(
    within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Excluir' }),
  );

describe('EnvironmentsPane', () => {
  it('opens the active environment first, switches between them and marks the active one', () => {
    setup({ activeId: 'e2' });
    expect(name().value).toBe('Production');
    expect(screen.getByTitle('Em uso')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Staging' }));
    expect(name().value).toBe('Staging');
    expect(screen.getByRole('button', { name: 'Usar este ambiente' })).toBeTruthy();
  });

  it('opens the first environment of the list when none is active', () => {
    setup();
    expect(name().value).toBe('Staging');
  });

  it('starts a new environment from a blank draft and saves it', async () => {
    const { client, onChanged } = setup();
    fireEvent.click(screen.getByTestId('new-environment'));
    expect(name().value).toBe('');
    expect(screen.queryByRole('button', { name: 'Usar este ambiente' })).toBeNull();
    expect((screen.getByTestId('save-environment') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(name(), { target: { value: 'QA' } });
    fireEvent.click(screen.getByTestId('save-environment'));
    await waitFor(() =>
      expect(client.saveApiEnvironment).toHaveBeenCalledWith(
        { name: 'QA', variables: [{ key: 'baseUrl', value: '' }] },
        undefined,
      ),
    );
    expect(await screen.findByText('Salvo.')).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
  });

  it('edits the variables of the draft and saves under the chosen environment', async () => {
    const { client } = setup();
    fireEvent.click(screen.getByRole('button', { name: /Adicionar variável/ }));
    fireEvent.click(screen.getByTestId('save-environment'));
    await waitFor(() =>
      expect(client.saveApiEnvironment).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Staging',
          variables: [...staging.variables, expect.objectContaining({ key: '' })],
        }),
        'e1',
      ),
    );
  });

  it('shows why a save failed', async () => {
    setup({}, { saveApiEnvironment: vi.fn(() => Promise.reject(new Error('name taken'))) });
    fireEvent.change(name(), { target: { value: 'Stage' } });
    fireEvent.click(screen.getByTestId('save-environment'));
    expect((await screen.findByRole('alert')).textContent).toContain('name taken');
  });

  it('keeps the other variables when one personal value is cleared', async () => {
    const { client } = setup();
    fireEvent.click(screen.getByTestId('clear-personal'));
    await waitFor(() => expect(client.clearPersonalSecret).toHaveBeenCalled());
    expect(await screen.findByText('Seu valor pessoal foi limpo.')).toBeTruthy();
    expect((screen.getByLabelText('baseUrl') as HTMLInputElement).value).toBe('https://stg.test');
  });

  it('reports a personal value that could not be cleared', async () => {
    setup({}, { clearPersonalSecret: vi.fn(() => Promise.reject(new Error('denied'))) });
    fireEvent.click(screen.getByTestId('clear-personal'));
    expect((await screen.findByRole('alert')).textContent).toContain('denied');
  });

  it('activates the picked environment', () => {
    const { onActivate } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Production' }));
    fireEvent.click(screen.getByRole('button', { name: 'Usar este ambiente' }));
    expect(onActivate).toHaveBeenCalledWith('e2');
  });

  it('asks before deleting, and deactivates the environment when it was the active one', async () => {
    const { client, onActivate, onChanged } = setup({ activeId: 'e1' });
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Excluir o ambiente "Staging"?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(client.deleteApiEnvironment).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    await confirmDelete();
    await waitFor(() => expect(client.deleteApiEnvironment).toHaveBeenCalledWith('e1'));
    expect(onActivate).toHaveBeenCalledWith('');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    await waitFor(() => expect(name().value).toBe(''));
  });

  it('leaves the active environment alone when another one is deleted, and reports failures', async () => {
    const { onActivate } = setup(
      { activeId: 'e2' },
      { deleteApiEnvironment: vi.fn(() => Promise.reject(new Error('in use'))) },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Staging' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    await confirmDelete();
    expect((await screen.findByRole('alert')).textContent).toContain('in use');
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('says there are no environments to a read-only member, and hides editing', () => {
    render(
      <EnvironmentsPane
        apiClient={{} as ApiClient}
        environments={[]}
        activeId=""
        readOnly
        onChanged={vi.fn()}
        onActivate={vi.fn()}
      />,
    );
    expect(screen.getByText('Nenhum ambiente ainda.')).toBeTruthy();
    expect(screen.queryByTestId('new-environment')).toBeNull();
  });
});
