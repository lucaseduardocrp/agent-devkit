import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { IntegrationTestsView } from '../src/features/apitests/IntegrationTestsView.js';
import { VariableInput } from '../src/features/apitests/VariableInput.js';
import type { ApiCollection } from '../src/features/apitests/api-test-types.js';
import {
  CodeEditor,
  type CodeEditorHandle,
} from '../src/features/apitests/integration/CodeEditor.js';
import { splitUrl } from '../src/features/apitests/integration/integration-model.js';
import { NameDialog } from '../src/features/apitests/integration/integration-parts.js';
import {
  VariablesContext,
  variableSuggestions,
} from '../src/features/apitests/variables-context.js';
import type { ApiClient } from '../src/lib/api-client.js';

describe('variableSuggestions', () => {
  it('leaves out disabled environment variables', () => {
    const list = variableSuggestions(
      { variables: [], items: [] },
      {
        variables: [
          { key: 'off', value: '1', enabled: false },
          { key: 'on', value: '2' },
        ],
      },
    );
    const names = list.map((item) => item.name);
    expect(names).toContain('on');
    expect(names).not.toContain('off');
  });
});

describe('splitUrl', () => {
  it('keeps only the disabled query rows when the address has no query', () => {
    const previous = [
      { key: 'a', value: '1' },
      { key: 'b', value: '2', enabled: false },
    ];
    expect(splitUrl('https://api.test/x', previous)).toEqual({
      url: 'https://api.test/x',
      query: [{ key: 'b', value: '2', enabled: false }],
    });
  });
});

describe('NameDialog', () => {
  it('does not submit a blank name, even when the form is submitted with Enter', () => {
    const onSubmit = vi.fn();
    render(
      <NameDialog
        open
        title="Name"
        initial="  "
        confirmLabel="Create"
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId<HTMLButtonElement>('name-dialog-submit').disabled).toBe(true);
    fireEvent.submit(screen.getByTestId('name-dialog'));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('VariableInput', () => {
  it('passes keys through when no suggestion list is open', () => {
    const onKeyDown = vi.fn();
    function Field() {
      const [value, setValue] = useState('');
      return (
        <VariablesContext.Provider value={[{ name: 'baseUrl', source: 'environment' }]}>
          <VariableInput
            aria-label="URL"
            value={value}
            onValueChange={setValue}
            onKeyDown={onKeyDown}
          />
        </VariablesContext.Provider>
      );
    }
    render(<Field />);
    fireEvent.keyDown(screen.getByLabelText('URL'), { key: 'Enter' });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });
});

describe('CodeEditor', () => {
  let handle: CodeEditorHandle | null = null;
  function Harness({ initial }: { initial: string }) {
    const [value, setValue] = useState(initial);
    return (
      <VariablesContext.Provider value={[{ name: 'baseUrl', source: 'environment' }]}>
        <CodeEditor
          ref={(current) => {
            handle = current;
          }}
          label="Body"
          value={value}
          language="json"
          readOnly={false}
          mocks={[]}
          onChange={setValue}
        />
      </VariablesContext.Provider>
    );
  }
  const editor = () => screen.getByLabelText<HTMLTextAreaElement>('Body');

  it('reports formatted JSON as formatted without rewriting it', () => {
    const text = '{\n  "a": 1\n}';
    const onChange = vi.fn();
    render(<Harness initial={text} />);
    editor().addEventListener('input', onChange);
    let result = false;
    act(() => {
      result = handle!.format();
    });
    expect(result).toBe(true);
    expect(editor().value).toBe(text);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps the suggestion list open for keys it does not handle', () => {
    render(<Harness initial="" />);
    editor().focus();
    fireEvent.change(editor(), { target: { value: '{{ba' } });
    editor().setSelectionRange(4, 4);
    fireEvent.keyUp(editor(), { key: 'a' });
    expect(screen.getByTestId('variable-suggestions')).toBeInTheDocument();
    fireEvent.keyDown(editor(), { key: 'Enter', ctrlKey: true });
    expect(screen.getByTestId('variable-suggestions')).toBeInTheDocument();
  });
});

describe('IntegrationTestsView import', () => {
  it('finishes an import that resolves after the view was closed', async () => {
    let finish: (value: { format: string; collection: ApiCollection }) => void = () => {};
    const collection = {
      id: 'c1',
      workspaceId: 'w1',
      name: 'Orders API',
      variables: [],
      auth: { type: 'none' },
      source: { kind: 'postman' },
      updatedAt: '',
      items: [],
    } as ApiCollection;
    const api = {
      listApiCollections: vi.fn(() => Promise.resolve([])),
      listApiEnvironments: vi.fn(() => Promise.resolve([])),
      listApiMockValues: vi.fn(() => Promise.resolve([])),
      getApiCollection: vi.fn(() => Promise.resolve(collection)),
      getAllSavedTestPlans: vi.fn(() => Promise.resolve([])),
      importApiCollection: vi.fn(
        () =>
          new Promise<{ format: string; collection: ApiCollection }>((done) => {
            finish = done;
          }),
      ),
    };
    const view = render(<IntegrationTestsView apiClient={api as unknown as ApiClient} />);
    const input = await view.findByTestId('import-input');
    const file = new File(['{}'], 'x.json');
    Object.defineProperty(file, 'text', { value: () => Promise.resolve('{}') });
    fireEvent.change(input, { target: { files: [file] } });
    await vi.waitFor(() => expect(api.importApiCollection).toHaveBeenCalled());
    view.unmount();
    await act(async () => finish({ format: 'postman', collection }));
    expect(api.listApiCollections).toHaveBeenCalled();
  });
});
