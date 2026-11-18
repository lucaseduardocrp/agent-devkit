import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type {
  ApiRequestSpec,
  LoadProfileType,
  LoadScenarioInput,
} from '../src/features/apitests/api-test-types.js';
import { emptyScenario } from '../src/features/apitests/load/load-model.js';
import { LoadPlanPane } from '../src/features/apitests/load/LoadPlanPane.js';

const request = (id: string, name: string, method: ApiRequestSpec['method'] = 'GET') =>
  ({
    id,
    type: 'request',
    name,
    method,
    url: '/x',
    headers: [],
    query: [],
    body: { mode: 'none' },
    auth: { type: 'inherit' },
    assertions: [],
    captures: [],
  }) as unknown as ApiRequestSpec;

const requests = [
  { request: request('r1', 'Login', 'POST'), path: [] as string[] },
  { request: request('r2', 'List'), path: ['Orders'] },
];

function Harness({
  initial,
  readOnly = false,
  loadingRequests,
  rows = requests,
  seen,
  onPreset,
  onApplyProfile,
}: {
  initial: LoadScenarioInput;
  readOnly?: boolean;
  loadingRequests?: boolean;
  rows?: typeof requests;
  seen?: (draft: LoadScenarioInput) => void;
  onPreset?: (preset: { vus: number; durationSec: number }) => void;
  onApplyProfile?: (profile: LoadProfileType) => void;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <LoadPlanPane
      draft={draft}
      requests={rows}
      loadingRequests={loadingRequests}
      preset={{ vus: 10, durationSec: 60 }}
      readOnly={readOnly}
      onChange={(next) => {
        seen?.(next);
        setDraft(next);
      }}
      onPreset={onPreset ?? (() => {})}
      onApplyProfile={onApplyProfile ?? (() => {})}
    />
  );
}

const base = (patch: Partial<LoadScenarioInput> = {}): LoadScenarioInput => ({
  ...emptyScenario('Checkout', 'c1'),
  requests: [{ requestId: 'r1', weight: 3 }],
  ...patch,
});

describe('LoadPlanPane', () => {
  it('chooses the test type and edits the preset', () => {
    const onApplyProfile = vi.fn();
    const onPreset = vi.fn();
    render(<Harness initial={base()} onApplyProfile={onApplyProfile} onPreset={onPreset} />);
    fireEvent.click(screen.getByTestId('profile-stress'));
    expect(onApplyProfile).toHaveBeenCalledWith('stress');
    fireEvent.change(screen.getByLabelText('VUs no pico'), { target: { value: '25' } });
    expect(onPreset).toHaveBeenLastCalledWith({ vus: 25, durationSec: 60 });
    fireEvent.change(screen.getByLabelText('Duração (s)'), { target: { value: '120' } });
    expect(onPreset).toHaveBeenLastCalledWith({ vus: 10, durationSec: 120 });
    fireEvent.click(screen.getByRole('button', { name: /Aplicar aos estágios/ }));
    expect(onApplyProfile).toHaveBeenLastCalledWith('load');
  });

  it('hides the preset for a custom plan', () => {
    render(<Harness initial={base({ profile: 'custom' })} />);
    expect(screen.queryByLabelText('VUs no pico')).toBeNull();
  });

  it('edits, adds and removes stages and turns the plan into a custom one', () => {
    const seen = vi.fn();
    render(<Harness initial={base()} seen={seen} />);
    fireEvent.change(screen.getByLabelText(/Estágio 1 · Duração/), { target: { value: '45' } });
    expect(seen).toHaveBeenLastCalledWith(
      expect.objectContaining({
        profile: 'custom',
        stages: expect.arrayContaining([{ durationSec: 45, targetVus: 10 }]),
      }),
    );
    fireEvent.change(screen.getByLabelText(/Estágio 2 · VUs alvo/), { target: { value: '80' } });
    expect(screen.getByTestId('plan-summary').textContent).toContain('80');
    fireEvent.click(screen.getByRole('button', { name: /Adicionar estágio/ }));
    expect(screen.getByLabelText(/Estágio 4 · VUs alvo/)).toBeTruthy();
    expect((screen.getByLabelText(/Estágio 4 · VUs alvo/) as HTMLInputElement).value).toBe('80');
    fireEvent.click(screen.getAllByRole('button', { name: 'Remover' })[0]!);
    expect(screen.queryByLabelText(/Estágio 4 · VUs alvo/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/Pausa entre requisições/), {
      target: { value: '250' },
    });
    expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ thinkTimeMs: 250 }));
  });

  it('adds a stage with the default load when the plan has no VUs', () => {
    const seen = vi.fn();
    render(<Harness initial={base({ stages: [{ durationSec: 10, targetVus: 0 }] })} seen={seen} />);
    // A single stage cannot be removed.
    // Only the two thresholds keep their remove button.
    expect(screen.getAllByRole('button', { name: 'Remover' })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /Adicionar estágio/ }));
    expect(seen).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stages: [
          { durationSec: 10, targetVus: 0 },
          { durationSec: 60, targetVus: 10 },
        ],
      }),
    );
  });

  it('selects requests, weighs them and shows their share of the load', () => {
    const seen = vi.fn();
    render(<Harness initial={base()} seen={seen} />);
    expect(screen.getByText('Orders / List')).toBeTruthy();
    expect(screen.getByText('100%', { selector: 'span' })).toBeTruthy();
    fireEvent.click(screen.getByLabelText('List'));
    expect(seen).toHaveBeenLastCalledWith(
      expect.objectContaining({
        requests: [
          { requestId: 'r1', weight: 3 },
          { requestId: 'r2', weight: 1 },
        ],
      }),
    );
    expect(screen.getByText('75%')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('peso · List'), { target: { value: '3' } });
    expect(screen.getAllByText('50%').length).toBe(2);
    fireEvent.click(screen.getByLabelText('Login'));
    expect(screen.queryByLabelText('peso · Login')).toBeNull();
    expect(screen.getByText('100%')).toBeTruthy();
  });

  it('shows no share while the weights add up to nothing', () => {
    render(
      <Harness
        initial={base({
          requests: [
            { requestId: 'r1', weight: 0 },
            { requestId: 'r2', weight: -5 },
          ],
        })}
      />,
    );
    expect(screen.getAllByText('0%', { selector: 'span' }).length).toBe(2);
  });

  it('shows the skeleton while the requests load and a notice when there are none', () => {
    const { unmount } = render(<Harness initial={base()} loadingRequests rows={[]} />);
    expect(screen.getAllByTestId('skeleton-request-row').length).toBeGreaterThan(0);
    expect(screen.queryByText('A coleção não tem requisições.')).toBeNull();
    unmount();
    render(<Harness initial={base()} rows={[]} />);
    expect(screen.getByText('A coleção não tem requisições.')).toBeTruthy();
    expect(screen.queryByTestId('skeleton-request-row')).toBeNull();
  });

  it('edits, adds and removes thresholds', () => {
    const seen = vi.fn();
    render(<Harness initial={base()} seen={seen} />);
    fireEvent.click(screen.getAllByRole('combobox', { name: 'Métrica' })[0]!);
    fireEvent.click(screen.getByRole('option', { name: 'Taxa de erros' }));
    expect(seen).toHaveBeenLastCalledWith(
      expect.objectContaining({
        thresholds: expect.arrayContaining([expect.objectContaining({ metric: 'p95' })]),
      }),
    );
    fireEvent.click(screen.getAllByRole('combobox', { name: 'Operador' })[1]!);
    fireEvent.click(screen.getByRole('option', { name: '≥' }));
    expect(seen.mock.lastCall![0].thresholds[1].operator).toBe('gte');
    fireEvent.change(screen.getAllByLabelText('Valor')[1]!, { target: { value: '800' } });
    expect(seen.mock.lastCall![0].thresholds[1].value).toBe(800);
    const stop = screen.getAllByRole('checkbox', { name: 'Parar ao falhar' });
    expect((stop[0] as HTMLInputElement).checked).toBe(false);
    fireEvent.click(stop[0]!);
    expect(seen.mock.lastCall![0].thresholds[0].abortOnFail).toBe(true);
    expect(
      (screen.getAllByRole('checkbox', { name: 'Parar ao falhar' })[0] as HTMLInputElement).checked,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Adicionar threshold/ }));
    expect(seen.mock.lastCall![0].thresholds).toHaveLength(3);
    const removers = screen.getAllByRole('button', { name: 'Remover' });
    fireEvent.click(removers[removers.length - 1]!);
    expect(seen.mock.lastCall![0].thresholds).toHaveLength(2);
  });

  it('is read only for members who cannot edit', () => {
    const { container } = render(<Harness initial={base()} readOnly />);
    expect(screen.queryByRole('button', { name: /Adicionar/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remover' })).toBeNull();
    expect(screen.queryByLabelText('VUs no pico')).toBeNull();
    expect((screen.getByTestId('profile-load') as HTMLButtonElement).disabled).toBe(true);
    const plan = within(container);
    expect(plan.getByLabelText(/Estágio 1 · Duração/)).toHaveProperty('disabled', true);
  });
});
