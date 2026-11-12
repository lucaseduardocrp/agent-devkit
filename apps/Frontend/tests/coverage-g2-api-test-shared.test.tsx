import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { KeyValue } from '../src/features/apitests/api-test-types.js';
import {
  GenerateDialog,
  KeyValueEditor,
  RunStatusBadge,
  TargetSelect,
} from '../src/features/apitests/ApiTestShared.js';
import type { ApiClient } from '../src/lib/api-client.js';

describe('RunStatusBadge and TargetSelect', () => {
  it('spins only while the run is going', () => {
    const { container, rerender } = render(<RunStatusBadge status="running" />);
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    rerender(<RunStatusBadge status="passed" />);
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  it('picks where the run happens', () => {
    const onChange = vi.fn();
    render(<TargetSelect value="remote" onChange={onChange} />);
    fireEvent.change(screen.getByTestId('run-target'), { target: { value: 'local' } });
    expect(onChange).toHaveBeenCalledWith('local');
  });
});

function Rows({
  initial,
  seen,
  ...props
}: {
  initial: KeyValue[];
  seen?: (rows: KeyValue[]) => void;
} & Partial<React.ComponentProps<typeof KeyValueEditor>>) {
  const [rows, setRows] = useState(initial);
  return (
    <KeyValueEditor
      rows={rows}
      onChange={(next) => {
        seen?.(next);
        setRows(next);
      }}
      {...props}
    />
  );
}

describe('KeyValueEditor', () => {
  it('toggles, edits, adds and removes rows', () => {
    const seen = vi.fn();
    render(
      <Rows
        seen={seen}
        initial={[
          { key: 'a', value: '1' },
          { key: 'b', value: '2', enabled: false },
        ]}
      />,
    );
    const toggles = screen.getAllByRole('checkbox', { name: 'Ativo' }) as HTMLInputElement[];
    expect(toggles.map((toggle) => toggle.checked)).toEqual([true, false]);
    fireEvent.click(toggles[0]!);
    expect(seen).toHaveBeenLastCalledWith([
      { key: 'a', value: '1', enabled: false },
      { key: 'b', value: '2', enabled: false },
    ]);
    fireEvent.click(toggles[1]!);
    expect(seen.mock.lastCall![0][1].enabled).toBeUndefined();
    fireEvent.change(screen.getAllByLabelText('Chave')[0]!, { target: { value: 'z' } });
    expect(seen.mock.lastCall![0][0].key).toBe('z');
    fireEvent.change(screen.getByLabelText('b'), { target: { value: '22' } });
    expect(seen.mock.lastCall![0][1].value).toBe('22');
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar' }));
    expect(seen.mock.lastCall![0]).toHaveLength(3);
    fireEvent.click(screen.getAllByRole('button', { name: 'Remover' })[0]!);
    expect(seen.mock.lastCall![0]).toHaveLength(2);
  });

  it('uses the given placeholders as labels', () => {
    render(
      <Rows
        initial={[{ key: '', value: '' }]}
        keyPlaceholder="Header"
        valuePlaceholder="Conteúdo"
      />,
    );
    expect(screen.getByLabelText('Header')).toBeTruthy();
    expect(screen.getByLabelText('Conteúdo')).toBeTruthy();
  });

  it('only edits the values when the keys are locked', () => {
    render(<Rows initial={[{ key: 'id', value: '' }]} lockKeys />);
    expect((screen.getByLabelText('Chave') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('id') as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('is read only', () => {
    render(<Rows initial={[{ key: 'a', value: '1' }]} readOnly />);
    expect((screen.getByLabelText('a') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('GenerateDialog', () => {
  function client(overrides: Record<string, unknown> = {}) {
    return {
      getAllSavedTestPlans: vi.fn(() => Promise.resolve([{ id: 'tp1', title: 'Plan one' }])),
      getTestSuites: vi.fn(() => Promise.resolve([{ id: 'ts1', name: 'Suite one' }])),
      getKnowledgeDocuments: vi.fn(() => Promise.resolve([{ pageId: 'b1', title: 'Doc one' }])),
      getSpecifications: vi.fn(() => Promise.resolve([{ id: 'sp1', title: 'Spec one' }])),
      getPbiItems: vi.fn(() => Promise.resolve([{ id: 'pbi1', title: 'Story one' }])),
      generateApiTests: vi.fn(() => Promise.resolve({ collection: { id: 'col9' } })),
      ...overrides,
    };
  }

  const mount = (
    api: ReturnType<typeof client>,
    props: Partial<React.ComponentProps<typeof GenerateDialog>> = {},
  ) => {
    const onGenerated = vi.fn();
    const onClose = vi.fn();
    const view = render(
      <GenerateDialog
        open
        kind="integration"
        apiClient={api as unknown as ApiClient}
        onClose={onClose}
        onGenerated={onGenerated}
        {...props}
      />,
    );
    return { view, onGenerated, onClose };
  };

  it('lists the sources of every type, selects them and generates integration tests', async () => {
    const api = client();
    const { onGenerated, onClose } = mount(api);
    const dialog = screen.getByTestId('generate-dialog');
    const submit = screen.getByTestId('generate-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(await within(dialog).findByLabelText('Plan one'));
    expect(submit.disabled).toBe(false);
    for (const [tab, title] of [
      ['Suítes', 'Suite one'],
      ['Cérebro', 'Doc one'],
      ['Specs', 'Spec one'],
      ['PBIs', 'Story one'],
    ] as const) {
      fireEvent.click(within(dialog).getByRole('button', { name: tab }));
      fireEvent.click(await within(dialog).findByLabelText(title));
    }
    expect(within(dialog).getByText(/Planos de teste: Plan one/)).toBeTruthy();
    // Unchecking removes the source again.
    fireEvent.click(within(dialog).getByLabelText('Story one'));
    expect(within(dialog).queryByText(/PBIs: Story one/)).toBeNull();
    fireEvent.change(within(dialog).getByPlaceholderText(/URL base/), {
      target: { value: ' https://api.test ' },
    });
    const instructions = dialog.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(instructions, { target: { value: '  only happy path  ' } });
    fireEvent.click(submit);
    await waitFor(() => expect(onGenerated).toHaveBeenCalledWith({ collectionId: 'col9' }));
    expect(api.generateApiTests).toHaveBeenCalledWith('integration', {
      sources: [
        { type: 'testPlan', id: 'tp1' },
        { type: 'testSuite', id: 'ts1' },
        { type: 'brain', id: 'b1' },
        { type: 'spec', id: 'sp1' },
      ],
      instructions: 'only happy path',
      baseUrl: 'https://api.test',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('filters the sources by title', async () => {
    const api = client({
      getAllSavedTestPlans: vi.fn(() =>
        Promise.resolve([
          { id: 'a', title: 'Alpha' },
          { id: 'b', title: 'Beta' },
        ]),
      ),
    });
    mount(api);
    await screen.findByLabelText('Alpha');
    fireEvent.change(screen.getByPlaceholderText('Buscar…'), { target: { value: ' bet ' } });
    expect(screen.queryByLabelText('Alpha')).toBeNull();
    expect(screen.getByLabelText('Beta')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Buscar…'), { target: { value: 'zzz' } });
    expect(screen.getByText('Nada para escolher aqui.')).toBeTruthy();
  });

  it('plans a load test of the collection from instructions alone and reports the scenario', async () => {
    const api = client({
      generateApiTests: vi.fn(() => Promise.resolve({ scenario: { id: 'sc7' } })),
    });
    const { onGenerated } = mount(api, { kind: 'load', collectionId: 'c1' });
    const dialog = screen.getByTestId('generate-dialog');
    expect(within(dialog).queryByPlaceholderText(/URL base/)).toBeNull();
    fireEvent.change(dialog.querySelector('textarea')!, { target: { value: 'ramp up' } });
    fireEvent.click(screen.getByTestId('generate-submit'));
    await waitFor(() => expect(onGenerated).toHaveBeenCalledWith({ scenarioId: 'sc7' }));
    expect(api.generateApiTests).toHaveBeenCalledWith('load', {
      sources: [],
      instructions: 'ramp up',
      collectionId: 'c1',
    });
  });

  it('does not send a collection for a load test without one', async () => {
    const api = client({ generateApiTests: vi.fn(() => Promise.resolve({})) });
    const { onGenerated } = mount(api, { kind: 'load' });
    fireEvent.click(await screen.findByLabelText('Plan one'));
    fireEvent.click(screen.getByTestId('generate-submit'));
    await waitFor(() => expect(onGenerated).toHaveBeenCalledWith({}));
    expect(api.generateApiTests).toHaveBeenCalledWith('load', {
      sources: [{ type: 'testPlan', id: 'tp1' }],
    });
  });

  it('shows why the generation failed, for errors and for other rejections', async () => {
    const api = client({
      generateApiTests: vi
        .fn()
        .mockRejectedValueOnce(new Error('Sem provedor de IA'))
        .mockRejectedValueOnce('quota'),
    });
    const { onGenerated } = mount(api);
    fireEvent.click(await screen.findByLabelText('Plan one'));
    fireEvent.click(screen.getByTestId('generate-submit'));
    expect((await screen.findByRole('alert')).textContent).toBe('Sem provedor de IA');
    fireEvent.click(screen.getByTestId('generate-submit'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('quota'));
    expect(onGenerated).not.toHaveBeenCalled();
  });

  it('shows no sources when the list cannot be loaded and ignores late answers', async () => {
    let resolve!: (value: { id: string; title: string }[]) => void;
    const api = client({
      getAllSavedTestPlans: vi.fn(
        () =>
          new Promise((done) => {
            resolve = done as typeof resolve;
          }),
      ),
      getTestSuites: vi.fn(() => Promise.reject(new Error('down'))),
    });
    mount(api);
    // The user moves on before the first list arrives.
    fireEvent.click(screen.getByRole('button', { name: 'Suítes' }));
    await waitFor(() => expect(api.getTestSuites).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('Nada para escolher aqui.')).toBeTruthy());
    resolve([{ id: 'late', title: 'Late plan' }]);
    await Promise.resolve();
    expect(screen.queryByLabelText('Late plan')).toBeNull();
  });

  it('does not load anything while closed', () => {
    const api = client();
    mount(api, { open: false });
    expect(api.getAllSavedTestPlans).not.toHaveBeenCalled();
  });
});
