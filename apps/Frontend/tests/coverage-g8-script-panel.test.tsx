import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { E2eScriptPanel } from '../src/features/e2e/E2eScriptPanel.js';
import type { E2eScriptKind } from '../src/features/e2e/e2e-types.js';
import type { ApiClient } from '../src/lib/api-client.js';

function script(kind: E2eScriptKind, content: string | null) {
  return {
    kind,
    path: `tests/e2e/tc007.${kind}.ts`,
    content,
    url: null,
    repository: {
      provider: 'github' as const,
      id: '42',
      name: 'acme/demo-app',
      branch: 'main',
    },
  };
}

function setup(
  kind: 'beforeRun' | 'afterRun',
  mode: 'frontend' | 'backend',
  content: string | null,
) {
  const client = {
    getE2eScript: vi.fn().mockResolvedValue(script(kind, content)),
    pushE2eScript: vi.fn(),
    saveE2eHookInstructions: vi.fn(),
  };
  const view = render(
    <E2eScriptPanel
      apiClient={client as unknown as ApiClient}
      testId="t1"
      kind={kind}
      mode={mode}
      instructions={null}
      isReadOnly={false}
      disabled={false}
    />,
  );
  return { client, view };
}

describe('E2eScriptPanel hook templates', () => {
  it('starts an After Run of an API test from a template without the browser page', async () => {
    const { view } = setup('afterRun', 'backend', null);
    fireEvent.click(await view.findByRole('button', { name: /Editar/ }));
    const editor = view.getByLabelText('After Run') as HTMLTextAreaElement;
    expect(editor.value).toContain('After Run steps');
    expect(editor.value).toContain('import { expect, test, type APIRequestContext } from');
    expect(editor.value).toContain(
      'export default async function afterRun({ request }: { request: APIRequestContext })',
    );
    expect(editor.value).not.toContain('Page');
  });

  it('keeps instructions saved for an After Run, falling back to none when the server omits them', async () => {
    const { view, client } = setup('afterRun', 'frontend', null);
    await view.findByText(/Este teste não tem After Run/);
    fireEvent.click(view.getByRole('button', { name: 'Alterar instruções' }));
    const editor = view.getByLabelText('Instruções para a IA');
    editor.innerHTML = '<p>Apagar o registro</p>';
    fireEvent.input(editor);
    client.saveE2eHookInstructions.mockResolvedValueOnce({
      afterRunInstructions: '<p>Apagar o registro</p>',
    });
    fireEvent.click(view.getByRole('button', { name: /Salvar instruções/ }));
    expect(await view.findByTestId('e2e-afterRun-instructions')).toHaveTextContent(
      'Apagar o registro',
    );
    expect(client.saveE2eHookInstructions).toHaveBeenCalledWith(
      't1',
      'afterRun',
      '<p>Apagar o registro</p>',
    );

    fireEvent.click(view.getByRole('button', { name: 'Alterar instruções' }));
    client.saveE2eHookInstructions.mockResolvedValueOnce({});
    fireEvent.click(view.getByRole('button', { name: /Salvar instruções/ }));
    await waitFor(() =>
      expect(
        view.getByText('Nenhuma instrução ainda. A IA decide como montar o cenário.'),
      ).toBeInTheDocument(),
    );
  });
});
