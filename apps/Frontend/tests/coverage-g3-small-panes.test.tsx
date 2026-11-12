import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiCollection } from '../src/features/apitests/api-test-types.js';
import { CollectionSettingsPane } from '../src/features/apitests/integration/CollectionSettingsPane.js';
import { DocsEditor } from '../src/features/apitests/integration/DocsEditor.js';
import { EditorPopover } from '../src/features/apitests/integration/EditorPopover.js';

describe('EditorPopover', () => {
  it('opens under its button, closes on the second click and on resize, and ignores other keys', () => {
    render(
      <EditorPopover icon="ti-wand" label="Tools" title="Tool panel">
        {() => <p>inside</p>}
      </EditorPopover>,
    );
    const trigger = screen.getByRole('button', { name: 'Tools' });

    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Tool panel' })).toBeTruthy();
    // Without a test id the panel has none either.
    expect(screen.getByRole('dialog').getAttribute('data-testid')).toBeNull();

    fireEvent.keyDown(document.body, { key: 'a' });
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.click(trigger);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(trigger);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent(window, new Event('resize'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps open on a click inside the panel and closes on a click outside', () => {
    render(
      <EditorPopover icon="ti-wand" label="Tools" title="Tool panel" testId="tools">
        {() => <p>inside</p>}
      </EditorPopover>,
    );
    fireEvent.click(screen.getByTestId('tools'));
    expect(screen.getByTestId('tools-panel')).toBeTruthy();
    fireEvent.mouseDown(screen.getByText('inside'));
    expect(screen.getByTestId('tools-panel')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('tools-panel')).toBeNull();
  });
});

describe('EditorPopover close', () => {
  it('closes from its content and gives the focus back to the button', () => {
    render(
      <EditorPopover icon="ti-wand" label="Tools" title="Tool panel">
        {(close) => <button onClick={close}>done</button>}
      </EditorPopover>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }));
    fireEvent.click(screen.getByRole('button', { name: 'done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Tools' }));
  });
});

describe('DocsEditor', () => {
  it('previews existing notes without a test id on the preview', () => {
    render(<DocsEditor value="Some **notes**" readOnly={false} onChange={() => undefined} />);
    expect(screen.getByText('notes')).toBeTruthy();
    expect(document.querySelector('[data-testid$="-preview"]')).toBeNull();
  });
});

const collection: ApiCollection = {
  id: 'c1',
  workspaceId: 'w1',
  name: 'Orders API',
  variables: [],
  auth: { type: 'none' },
  source: { kind: 'custom-kind' },
  updatedAt: '',
  items: [],
};

function Settings({ onChange }: { onChange: (next: ApiCollection) => void }) {
  const [current, setCurrent] = useState(collection);
  return (
    <CollectionSettingsPane
      collection={current}
      readOnly={false}
      onChange={(next) => {
        setCurrent(next);
        onChange(next);
      }}
      onExport={() => undefined}
      onDelete={() => undefined}
    />
  );
}

describe('CollectionSettingsPane without an error handler', () => {
  it('survives a file that cannot be read, and takes a zero from the number fields', async () => {
    const onChange = vi.fn();
    render(<Settings onChange={onChange} />);
    fireEvent.click(screen.getByRole('tab', { name: /TLS/ }));
    const file = screen.getByLabelText('Carregar arquivo', { selector: 'input' });
    fireEvent.change(file, { target: { files: [{} as File] } });
    await act(async () => {
      await Promise.resolve();
    });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('tab', { name: /Rede/ }));
    fireEvent.change(screen.getByLabelText('Timeout (ms)'), { target: { value: '0' } });
    expect(onChange.mock.calls.at(-1)![0].settings.timeoutMs).toBe(0);
  });
});
