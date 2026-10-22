import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { E2eTestDetail } from '../src/features/e2e/E2eTestDetail.js';
import { formatDuration, type E2eTestDetail as Dto } from '../src/features/e2e/e2e-types.js';
import type { ApiClient } from '../src/lib/api-client.js';

function detail(overrides: Partial<Dto> = {}): Dto {
  return {
    id: 't1',
    creationId: 'c1',
    position: 7,
    code: 'TC007',
    title: 'Ensure real-time ordering',
    description: 'Validate that the list reorders in real time.',
    steps: ['Open the event', 'Vote'],
    priority: 'high',
    status: 'failed',
    error: 'expect(locator).toBeVisible() failed',
    analysis: 'Goal: ...\nWhat failed: ...',
    verdict: 'app_bug',
    durationMs: 65_000,
    attempts: 2,
    hasVideo: true,
    externalCase: null,
    stepResults: [],
    createdAt: '2026-01-30T09:23:00Z',
    updatedAt: '2026-01-30T09:27:00Z',
    lastRunAt: '2026-01-30T09:27:00Z',
    scriptPath: 'tests/e2e/tc007-ordering.spec.ts',
    logs: 'Running 1 test',
    creation: {
      id: 'c1',
      name: 'ama',
      mode: 'frontend',
      baseUrl: 'http://localhost:3000',
      path: '/e/123',
      status: 'completed',
    },
    ...overrides,
  };
}

const SPEC = "import { test } from '@playwright/test';";
function script(content: string | null = SPEC) {
  return {
    path: 'tests/e2e/tc007-ordering.spec.ts',
    content,
    url: 'https://github.com/acme/demo-app/blob/main/tests/e2e/tc007-ordering.spec.ts',
    repository: {
      provider: 'github' as const,
      id: '42',
      name: 'acme/demo-app',
      branch: 'main',
      path: 'tests/e2e',
    },
  };
}

function setup(response: Dto | Error = detail(), isReadOnly = false) {
  const client = {
    getE2eTest: vi.fn(() =>
      response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
    ),
    getE2eTestVideo: vi.fn().mockResolvedValue(new Blob(['video'])),
    getE2eTestVideoUrl: vi.fn().mockResolvedValue(null),
    rerunE2eTest: vi.fn().mockResolvedValue(undefined),
    getE2eScript: vi.fn().mockResolvedValue(script()),
    pushE2eScript: vi.fn(),
  };
  const onBack = vi.fn();
  const view = render(
    <E2eTestDetail
      apiClient={client as unknown as ApiClient}
      testId="t1"
      isReadOnly={isReadOnly}
      onBack={onBack}
    />,
  );
  return { client, view, onBack };
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:video');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.useRealTimers());

/** Description, steps, linked case and details live in the Test Case tab. */
async function openInfoTab(view: ReturnType<typeof setup>['view']) {
  fireEvent.click(await view.findByRole('tab', { name: 'Test Case' }));
}

describe('E2eTestDetail', () => {
  it('shows which computer executed the latest run', async () => {
    const local = setup(detail({ executedOn: 'QA-LAPTOP (win32)' }));
    await openInfoTab(local.view);
    expect(local.view.getByText('QA-LAPTOP (win32)')).toBeInTheDocument();
    local.view.unmount();
    const remote = setup(detail());
    await openInfoTab(remote.view);
    expect(remote.view.getByText('Servidores do ADK')).toBeInTheDocument();
  });

  it('shows the test case, with formatted content, in a tab between Preview and Code', async () => {
    const { view } = setup(
      detail({
        description: '<b>## Caso de uso</b><br>Validar a **ordem** da lista.',
        steps: ['Abra o evento. => A lista é exibida.', 'Vote'],
      }),
    );
    await view.findByText('TC007-Ensure real-time ordering');
    expect(view.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Preview',
      'Test Case',
      'Código',
    ]);
    expect(view.queryByText('Caso de uso')).toBeNull();
    await openInfoTab(view);
    expect(view.getByRole('tab', { name: 'Test Case' })).toHaveAttribute('aria-selected', 'true');
    expect(view.queryByTestId('e2e-video')).toBeNull();
    expect(view.getByText('Caso de uso')).toBeInTheDocument();
    expect(view.getByText('ordem').tagName).toBe('STRONG');
    expect(view.getByText('Abra o evento.')).toBeInTheDocument();
    expect(view.getByText('A lista é exibida.')).toBeInTheDocument();
    expect(view.getAllByText('Resultado Esperado:')).toHaveLength(1);
    expect(view.getByText('Nenhum test case vinculado.')).toBeInTheDocument();
    view.unmount();

    const markdown = setup(detail({ description: '# Objetivo\n\n- Ordenar **votos**', steps: [] }));
    await openInfoTab(markdown.view);
    expect(markdown.view.getByTestId('markdown-viewer')).toBeInTheDocument();
    expect(markdown.view.getByText('Nenhum passo planejado.')).toBeInTheDocument();
  });

  it('warns when a Quick Tunnel run has no original localhost origin', async () => {
    const creation = {
      ...detail().creation,
      baseUrl: 'https://example.trycloudflare.com',
      localOrigin: null,
    };
    const { view } = setup(detail({ creation }));
    expect(await view.findByRole('alert')).toHaveTextContent('Informe o endereço local original');
    view.unmount();

    const configured = setup(
      detail({ creation: { ...creation, localOrigin: 'http://localhost:8014' } }),
    );
    await configured.view.findByText('TC007-Ensure real-time ordering');
    expect(configured.view.queryByText(/Informe o endereço local original/)).toBeNull();
    await openInfoTab(configured.view);
    expect(configured.view.getByText('http://localhost:8014')).toBeInTheDocument();
  });

  it('shows the description, video, error and AI analysis of a failed test', async () => {
    const { view, client } = setup();
    expect(await view.findByText('TC007-Ensure real-time ordering')).toBeInTheDocument();
    expect(view.getByText('Failed')).toBeInTheDocument();
    const video = await view.findByTestId('e2e-video');
    expect(video).toHaveAttribute('src', 'blob:video');
    expect(client.getE2eTestVideo).toHaveBeenCalledWith('t1', expect.any(AbortSignal));
    expect(view.getByText('expect(locator).toBeVisible() failed')).toBeInTheDocument();
    expect(view.getByText('Bug na aplicação')).toBeInTheDocument();
    await openInfoTab(view);
    expect(view.getByText('Validate that the list reorders in real time.')).toBeInTheDocument();
    expect(view.getByText('Vote')).toBeInTheDocument();
    expect(view.getByText('Alta')).toBeInTheDocument();
    expect(view.getByText('1m 5s')).toBeInTheDocument();

    fireEvent.click(view.getByRole('button', { name: /Logs da execução/ }));
    expect(view.getByText('Running 1 test')).toBeInTheDocument();
    fireEvent.click(view.getByRole('tab', { name: 'Código' }));
    await waitFor(() =>
      expect(view.container.querySelector('code')?.textContent).toContain('@playwright/test'),
    );
    expect(
      view.getByText('acme/demo-app@main/tests/e2e/tc007-ordering.spec.ts'),
    ).toBeInTheDocument();
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:video');
  });

  it('reruns and regenerates the test, reporting failures', async () => {
    const { view, client } = setup();
    await view.findByText('TC007-Ensure real-time ordering');
    fireEvent.click(view.getByRole('button', { name: /Executar novamente/ }));
    await waitFor(() => expect(client.rerunE2eTest).toHaveBeenCalledWith('t1', false));
    fireEvent.click(view.getByRole('button', { name: /Regenerar script/ }));
    await waitFor(() => expect(client.rerunE2eTest).toHaveBeenCalledWith('t1', true));
    client.rerunE2eTest.mockRejectedValueOnce(new Error('Já em andamento'));
    fireEvent.click(view.getByRole('button', { name: /Executar novamente/ }));
    expect(await view.findByText('Já em andamento')).toBeInTheDocument();
    client.rerunE2eTest.mockRejectedValueOnce('boom');
    fireEvent.click(view.getByRole('button', { name: /Executar novamente/ }));
    expect(await view.findByText('Não foi possível concluir a ação.')).toBeInTheDocument();
  });

  it('polls while the test is active and hides results until it settles', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { view, client } = setup(detail({ status: 'running', error: 'old', analysis: 'old' }));
    expect(await view.findByText('A IA está trabalhando neste teste…')).toBeInTheDocument();
    expect(view.queryByText('old')).toBeNull();
    client.getE2eTest.mockResolvedValue(
      detail({ status: 'passed', error: null, analysis: null, verdict: null, logs: null }),
    );
    await act(() => vi.advanceTimersByTimeAsync(3100));
    expect(await view.findByText('Pass')).toBeInTheDocument();
    expect(view.queryByRole('button', { name: /Logs da execução/ })).toBeNull();
  });

  it('explains missing videos and scripts and test issues', async () => {
    const { view, client } = setup(
      detail({
        hasVideo: false,
        scriptPath: null,
        verdict: 'test_issue',
        steps: [],
        durationMs: null,
        lastRunAt: null,
        description: '',
      }),
    );
    expect(await view.findByText('Nenhum vídeo disponível para este teste.')).toBeInTheDocument();
    expect(view.getByText('Problema no teste')).toBeInTheDocument();
    // Without a description, the Test Case tab describes the test by its title.
    await openInfoTab(view);
    expect(view.getAllByText('Ensure real-time ordering').length).toBeGreaterThan(0);
    client.getE2eScript.mockResolvedValueOnce(script(null));
    fireEvent.click(view.getByRole('tab', { name: 'Código' }));
    expect(await view.findByText('O script ainda não foi gerado.')).toBeInTheDocument();
    fireEvent.click(view.getByRole('tab', { name: 'Preview' }));
  });

  it('explains that backend tests have no video and hides actions for viewers', async () => {
    const { view } = setup(
      detail({
        hasVideo: false,
        verdict: null,
        priority: 'low',
        creation: { ...detail().creation, mode: 'backend' },
      }),
      true,
    );
    expect(
      await view.findByText('Testes de backend validam a API diretamente e não geram vídeo.'),
    ).toBeInTheDocument();
    await openInfoTab(view);
    expect(view.getByText('Backend')).toBeInTheDocument();
    expect(view.getByText('Baixa')).toBeInTheDocument();
    expect(view.queryByRole('button', { name: /Executar novamente/ })).toBeNull();
  });

  it('offers a download when the browser cannot decode the video', async () => {
    const { view, client } = setup();
    client.getE2eTestVideo.mockResolvedValueOnce(new Blob(['v'], { type: 'video/mp4' }));
    fireEvent.error(await view.findByTestId('e2e-video'));
    expect(view.getByText('Este navegador não conseguiu reproduzir o vídeo.')).toBeInTheDocument();
    const link = view.getByRole('link', { name: 'Baixar vídeo' });
    expect(link).toHaveAttribute('href', 'blob:video');
    expect(link).toHaveAttribute('download', 't1.mp4');
    view.unmount();

    const webm = setup();
    fireEvent.error(await webm.view.findByTestId('e2e-video'));
    expect(webm.view.getByRole('link', { name: 'Baixar vídeo' })).toHaveAttribute(
      'download',
      't1.webm',
    );
  });

  it('streams the video straight from object storage when the backend signs a URL', async () => {
    const { view, client } = setup();
    client.getE2eTestVideoUrl.mockResolvedValue({
      url: 'https://r2.example/e2e/ws/c1/t1.mp4?X-Amz-Signature=abc',
      mimeType: 'video/mp4',
    });
    const video = await view.findByTestId('e2e-video');
    expect(video).toHaveAttribute('src', 'https://r2.example/e2e/ws/c1/t1.mp4?X-Amz-Signature=abc');
    expect(client.getE2eTestVideo).not.toHaveBeenCalled();
    fireEvent.error(video);
    expect(view.getByRole('link', { name: 'Baixar vídeo' })).toHaveAttribute('download', 't1.mp4');
    view.unmount();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it('reports video failures', async () => {
    const { view, client } = setup(detail({ priority: 'medium', lastRunAt: null }));
    client.getE2eTestVideo.mockRejectedValueOnce(new Error('404'));
    expect(await view.findByText('Não foi possível carregar o vídeo.')).toBeInTheDocument();
    await openInfoTab(view);
    expect(view.getByText('Média')).toBeInTheDocument();
  });

  it('handles load errors and navigation back', async () => {
    const failed = setup(new Error('Teste não encontrado'));
    expect(await failed.view.findByText('Teste não encontrado')).toBeInTheDocument();
    fireEvent.click(failed.view.getByRole('button', { name: /Voltar/ }));
    expect(failed.onBack).toHaveBeenCalled();
    failed.view.unmount();

    const client = {
      getE2eTest: vi.fn().mockRejectedValue('down'),
      getE2eTestVideo: vi.fn(),
      rerunE2eTest: vi.fn(),
    };
    const view = render(
      <E2eTestDetail apiClient={client as unknown as ApiClient} testId="x" onBack={vi.fn()} />,
    );
    expect(
      await view.findByText('Não foi possível carregar as execuções E2E.'),
    ).toBeInTheDocument();
  });

  it('shows a skeleton while loading', () => {
    const client = {
      getE2eTest: vi.fn(() => new Promise(() => undefined)),
      getE2eTestVideo: vi.fn(),
      rerunE2eTest: vi.fn(),
    };
    const view = render(
      <E2eTestDetail apiClient={client as unknown as ApiClient} testId="x" onBack={vi.fn()} />,
    );
    expect(
      view.getByTestId('e2e-test-detail').querySelector('.animate-pulse, [class*="skeleton"]'),
    ).not.toBeNull();
  });

  it('pulls, edits and pushes the spec in the repository', async () => {
    const { view, client } = setup(detail({ status: 'passed', error: null, analysis: null }));
    await view.findByText('TC007-Ensure real-time ordering');
    fireEvent.click(view.getByRole('tab', { name: 'Código' }));
    await waitFor(() => expect(client.getE2eScript).toHaveBeenCalledWith('t1'));
    expect(await view.findByRole('link', { name: 'Abrir no repositório' })).toHaveAttribute(
      'href',
      'https://github.com/acme/demo-app/blob/main/tests/e2e/tc007-ordering.spec.ts',
    );

    fireEvent.click(view.getByRole('button', { name: /Editar/ }));
    const editor = view.getByLabelText('Código') as HTMLTextAreaElement;
    expect(editor.value).toBe(SPEC);
    expect(view.getByRole('button', { name: /Push/ })).toHaveProperty('disabled', true);
    fireEvent.change(editor, { target: { value: `${SPEC}\n// edited` } });
    client.pushE2eScript.mockResolvedValueOnce(script(`${SPEC}\n// edited`));
    fireEvent.click(view.getByRole('button', { name: /Push/ }));
    await waitFor(() =>
      expect(client.pushE2eScript).toHaveBeenCalledWith('t1', `${SPEC}\n// edited`),
    );
    expect(await view.findByText('Script enviado para o repositório.')).toBeInTheDocument();
    expect(view.queryByLabelText('Código')).toBeNull();

    fireEvent.click(view.getByRole('button', { name: /Editar/ }));
    fireEvent.change(view.getByLabelText('Código'), { target: { value: 'eval(1)' } });
    client.pushE2eScript.mockRejectedValueOnce(new Error('Script bloqueado'));
    fireEvent.click(view.getByRole('button', { name: /Push/ }));
    expect(await view.findByText('Script bloqueado')).toBeInTheDocument();
    client.pushE2eScript.mockRejectedValueOnce('boom');
    fireEvent.click(view.getByRole('button', { name: /Push/ }));
    expect(await view.findByText('Não foi possível enviar o script.')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Cancelar' }));
    expect(view.queryByLabelText('Código')).toBeNull();

    client.getE2eScript.mockRejectedValueOnce(new Error('Repositório indisponível'));
    fireEvent.click(view.getByRole('button', { name: /Pull/ }));
    expect(await view.findByText('Repositório indisponível')).toBeInTheDocument();
    client.getE2eScript.mockRejectedValueOnce('boom');
    fireEvent.click(view.getByRole('button', { name: /Pull/ }));
    expect(
      await view.findByText('Não foi possível carregar o script do repositório.'),
    ).toBeInTheDocument();
    client.getE2eScript.mockResolvedValueOnce({ ...script(), url: null });
    fireEvent.click(view.getByRole('button', { name: /Pull/ }));
    await waitFor(() =>
      expect(view.queryByRole('link', { name: 'Abrir no repositório' })).toBeNull(),
    );
  });

  it('writes a first version of a spec missing from the repository', async () => {
    const { view, client } = setup(detail({ status: 'passed' }));
    client.getE2eScript.mockResolvedValueOnce(script(null));
    await view.findByText('TC007-Ensure real-time ordering');
    fireEvent.click(view.getByRole('tab', { name: 'Código' }));
    expect(await view.findByText('O script ainda não foi gerado.')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: /Editar/ }));
    expect((view.getByLabelText('Código') as HTMLTextAreaElement).value).toBe('');
    fireEvent.change(view.getByLabelText('Código'), { target: { value: SPEC } });
    client.pushE2eScript.mockResolvedValueOnce(script());
    fireEvent.click(view.getByRole('button', { name: /Push/ }));
    await waitFor(() => expect(client.pushE2eScript).toHaveBeenCalledWith('t1', SPEC));
  });

  it('keeps the spec read-only for viewers', async () => {
    const { view } = setup(detail(), true);
    await view.findByText('TC007-Ensure real-time ordering');
    fireEvent.click(view.getByRole('tab', { name: 'Código' }));
    await waitFor(() => expect(view.container.querySelector('code')).not.toBeNull());
    expect(view.queryByRole('button', { name: /Editar/ })).toBeNull();
    expect(view.getByRole('button', { name: /Pull/ })).toBeInTheDocument();
  });

  it('formats durations', () => {
    expect(formatDuration(450)).toBe('450ms');
    expect(formatDuration(1234)).toBe('1.2s');
    expect(formatDuration(125_000)).toBe('2m 5s');
  });
});
