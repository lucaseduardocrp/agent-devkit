import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  ActivityProvider,
  ActivityCenter,
  useActivities,
  useActivityRunner,
} from '../src/features/activities/ActivityCenter.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function ActivityHarness({ operation }: { readonly operation: () => Promise<string> }) {
  const { runActivity } = useActivityRunner();
  const [result, setResult] = useState('');
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void runActivity({ kind: 'sync', title: 'Sincronizando Docs' }, operation)
            .then(setResult)
            .catch(() => setResult('erro'))
        }
      >
        Executar {result}
      </button>
      <ActivityCenter />
    </>
  );
}

describe('ActivityCenter', () => {
  it('keeps an operation visible while it runs and reports its completion', async () => {
    const operation = deferred<string>();
    render(
      <ActivityProvider>
        <ActivityHarness operation={() => operation.promise} />
      </ActivityProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Executar' }));
    expect(screen.getByText('1 em andamento')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /abrir central de atividades/i }));
    expect(screen.getByText('Sincronizando Docs')).toBeInTheDocument();
    expect(screen.getByText(/você pode continuar navegando/i)).toBeInTheDocument();

    await act(async () => operation.resolve('pronto'));
    expect(screen.getByText('Concluída')).toBeInTheDocument();
    expect(screen.getAllByText('Atividades')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Fechar atividades' }));
    expect(screen.queryByLabelText('Central de atividades')).not.toBeInTheDocument();
    expect(screen.getByRole('status').className).toContain('absolute right-0 top-full');
    expect(screen.getByText('Atividade concluída')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fechar notificação' }));
    expect(screen.queryByText('Atividade concluída')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /abrir central de atividades/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Limpar concluídas' }));
    expect(screen.getByText('Nenhuma atividade recente.')).toBeInTheDocument();
  });

  it('shows the failure reason and retains running items when finished items are cleared', async () => {
    const failure = deferred<string>();
    const pending = deferred<string>();
    const operation = vi
      .fn()
      .mockReturnValueOnce(failure.promise)
      .mockReturnValueOnce(pending.promise);
    render(
      <ActivityProvider>
        <ActivityHarness operation={operation} />
      </ActivityProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Executar' }));
    await act(async () => failure.reject(new Error('Azure indisponível')));
    expect(screen.getByRole('alert')).toHaveTextContent('Atividade não concluída');
    fireEvent.click(screen.getByRole('button', { name: 'Executar erro' }));
    fireEvent.click(screen.getByRole('button', { name: /abrir central de atividades/i }));
    expect(screen.getByText('Azure indisponível')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Limpar concluídas' }));
    expect(screen.getByText(/você pode continuar navegando/i)).toBeInTheDocument();
    await act(async () => pending.resolve('ok'));
  });

  it('runs directly without a provider and guards the strict context hook', async () => {
    const operation = vi.fn().mockResolvedValue('direto');
    render(<ActivityHarness operation={operation} />);
    fireEvent.click(screen.getByRole('button', { name: 'Executar' }));
    expect(await screen.findByRole('button', { name: 'Executar direto' })).toBeInTheDocument();

    function InvalidConsumer() {
      useActivities();
      return null;
    }
    expect(() => render(<InvalidConsumer />)).toThrow(
      'useActivities must be used within ActivityProvider',
    );
  });
});
