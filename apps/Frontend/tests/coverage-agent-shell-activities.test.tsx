import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  ActivityCenter,
  ActivityProvider,
  useActivities,
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

/** Starts activities through the strict context hook and lists their state. */
function ActivityConsole({ operations }: { readonly operations: (() => Promise<string>)[] }) {
  const { activities, runActivity, clearFinished } = useActivities();
  return (
    <>
      {operations.map((operation, index) => (
        <button
          key={index}
          type="button"
          onClick={() =>
            void runActivity({ kind: 'push', title: `Publicação ${index + 1}` }, operation).catch(
              () => undefined,
            )
          }
        >
          {`Iniciar ${index + 1}`}
        </button>
      ))}
      <button type="button" onClick={clearFinished}>
        Limpar
      </button>
      <ul aria-label="Estados">
        {activities.map((item) => (
          <li key={item.id}>{`${item.title}: ${item.status}`}</li>
        ))}
      </ul>
      <ActivityCenter />
    </>
  );
}

describe('ActivityProvider through useActivities', () => {
  it('keeps other activities running when one of them fails', async () => {
    const failing = deferred<string>();
    const running = deferred<string>();
    render(
      <ActivityProvider>
        <ActivityConsole operations={[() => failing.promise, () => running.promise]} />
      </ActivityProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Iniciar 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar 2' }));
    await act(async () => failing.reject('falha sem detalhes'));

    const states = screen.getByRole('list', { name: 'Estados' });
    expect(states).toHaveTextContent('Publicação 1: error');
    expect(states).toHaveTextContent('Publicação 2: running');

    fireEvent.click(screen.getByRole('button', { name: /abrir central de atividades/i }));
    expect(screen.getByText('Erro')).toBeInTheDocument();

    await act(async () => running.resolve('ok'));
    expect(states).toHaveTextContent('Publicação 1: error');
    expect(states).toHaveTextContent('Publicação 2: success');

    fireEvent.click(screen.getByRole('button', { name: 'Limpar' }));
    expect(states.children).toHaveLength(0);
  });

  it('falls back to the generic failure text when the error has no message', async () => {
    const failing = deferred<string>();
    render(
      <ActivityProvider>
        <ActivityConsole operations={[() => failing.promise]} />
      </ActivityProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Iniciar 1' }));
    await act(async () => failing.reject(new Error('')));
    fireEvent.click(screen.getByRole('button', { name: /abrir central de atividades/i }));

    const list = screen.getByLabelText('Central de atividades');
    expect(list).toHaveTextContent('Publicação 1');
    expect(list).toHaveTextContent('Atividade não concluída');
  });

  it('shows an empty center without a provider', () => {
    render(<ActivityCenter />);
    fireEvent.click(screen.getByRole('button', { name: /abrir central de atividades/i }));
    expect(screen.getByText('Nenhuma atividade recente.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Limpar concluídas' })).not.toBeInTheDocument();
  });
});
