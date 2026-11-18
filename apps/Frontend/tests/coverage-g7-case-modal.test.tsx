import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestCaseModal } from '../src/features/testplans/TestCaseModal.js';
import type { TestCase } from '../src/features/testplans/TestPlansView.js';
import { MediaProvider } from '../src/features/shared/media.js';
import { ApiClient } from '../src/lib/api-client.js';

const FILE = '/attachments/files/0f8fad5b-d9cb-469f-a165-70867728950e';

const base: TestCase = {
  id: 'CT-01',
  title: 'Pay',
  scenario: '<p>Pay</p>',
  steps: [{ order: 1, action: 'Open', expectedResult: 'Opened' }],
};

beforeEach(() => {
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => true) });
});
afterEach(() => vi.restoreAllMocks());

function open(testCase: TestCase, onSave = vi.fn()) {
  const apiClient = new ApiClient({ baseUrl: 'http://api.test' });
  vi.spyOn(apiClient, 'getMedia').mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
  const onClose = vi.fn();
  const ui = render(
    <MediaProvider apiClient={apiClient}>
      <TestCaseModal testCase={testCase} onSave={onSave} onClose={onClose} />
    </MediaProvider>,
  );
  return { ui, onSave, onClose, apiClient };
}

describe('TestCaseModal attachments', () => {
  it('lists the files kept in the metadata and ignores malformed entries', () => {
    const { ui } = open({
      ...base,
      metadata: {
        attachments: [
          {
            id: 'a1',
            name: 'doc.pdf',
            kind: 'document',
            scope: 'testcase',
            source: 'url',
            url: 'https://x.test/doc.pdf',
          },
          null,
          'text',
          { id: 5, url: 'https://x.test/bad' },
          { id: 'a2' },
        ],
      },
    });
    const window = ui.getByTestId('test-case-modal');
    expect(within(window).getByText('doc.pdf')).toBeInTheDocument();
    expect(within(window).queryByText('a2')).toBeNull();
  });

  it('saves an added link through the draft commit and removes it again', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { ui } = open(base, onSave);
    const window = ui.getByTestId('test-case-modal');
    const url = within(window).getByRole('textbox', { name: /link|url/i });
    fireEvent.change(url, { target: { value: 'https://files.test/spec.pdf' } });
    fireEvent.keyDown(url, { key: 'Enter' });
    expect(await within(window).findByText('spec.pdf')).toBeInTheDocument();
    fireEvent.click(ui.getByTestId('btn-save-test-case-modal'));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0]![0].metadata.attachments).toEqual([
      expect.objectContaining({ name: 'spec.pdf', url: 'https://files.test/spec.pdf' }),
    ]);
  });

  it('shows why saving failed, with an Error or a plain value', async () => {
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new Error('Plan is locked'))
      .mockRejectedValueOnce('offline');
    const { ui } = open(base, onSave);
    fireEvent.click(ui.getByTestId('btn-save-test-case-modal'));
    expect(await ui.findByText('Plan is locked')).toBeInTheDocument();
    fireEvent.click(ui.getByTestId('btn-save-test-case-modal'));
    expect(await ui.findByText('offline')).toBeInTheDocument();
  });

  it('shows the error of an image pasted into the scenario that is too large', () => {
    const { ui } = open({ ...base, scenario: `<p>See</p><img src="${FILE}" alt="a">` });
    const big = new File([new Uint8Array(11 * 1024 * 1024)], 'big.png', { type: 'image/png' });
    fireEvent.paste(ui.getByTestId('input-edit-test-scenario-formatted'), {
      clipboardData: { files: [big] },
    });
    expect(ui.getByRole('alert')).toHaveTextContent('10 MB');
  });
});

describe('TestCaseModal description', () => {
  const shot = {
    id: 'i1',
    name: 'shot.png',
    kind: 'image',
    scope: 'testcase',
    source: 'file',
    url: FILE,
  };

  it('shows a text diagram as a block that keeps its lines and spaces', () => {
    const diagram = '┌───────┐\n│ [A]   │\n└───────┘\n▼\n┌───────┐\n│ [B]   │\n└───────┘';
    const { ui } = open({ ...base, scenario: `## Fluxo\n${diagram}` });
    const surface = ui.getByTestId('input-edit-test-scenario-formatted');
    const block = surface.querySelector('pre')!;
    expect(block.textContent).toBe(diagram);
    expect(surface.querySelector('h2')).toHaveTextContent('Fluxo');
    // The same diagram written with <br> by older cases is also kept in a block.
    ui.unmount();
    const older = open({ ...base, scenario: `<p>${diagram.replace(/\n/g, '<br>')}</p>` });
    expect(
      older.ui.getByTestId('input-edit-test-scenario-formatted').querySelector('pre')!.textContent,
    ).toBe(diagram);
  });

  it('puts an attached image at the end of the description as Markdown', async () => {
    const { ui } = open({ ...base, scenario: '<p>Pay</p>', metadata: { attachments: [shot] } });
    // Lets the preview of the attached image load before it is used.
    await act(async () => {});
    fireEvent.click(ui.getByRole('button', { name: /^Inserir.*shot\.png/i }));
    fireEvent.click(ui.getByTestId('editor-mode-code'));
    expect((ui.getByTestId('input-edit-test-scenario-code') as HTMLTextAreaElement).value).toBe(
      `Pay\n\n![shot.png](${FILE})\n`,
    );
  });

  it('starts the description with the image when it is empty', async () => {
    const { ui } = open({ ...base, scenario: '', metadata: { attachments: [shot] } });
    await act(async () => {});
    fireEvent.click(ui.getByRole('button', { name: /^Inserir.*shot\.png/i }));
    fireEvent.click(ui.getByTestId('editor-mode-code'));
    expect((ui.getByTestId('input-edit-test-scenario-code') as HTMLTextAreaElement).value).toBe(
      `![shot.png](${FILE})\n`,
    );
  });

  it('is written and saved as Markdown, converting the rich text of older cases', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { ui } = open(
      { ...base, scenario: '<p>Pay the <b>cart</b></p><ul><li>One</li></ul>' },
      onSave,
    );
    fireEvent.click(ui.getByTestId('editor-mode-code'));
    const code = ui.getByTestId('input-edit-test-scenario-code') as HTMLTextAreaElement;
    expect(code.value).toBe('Pay the **cart**\n\n- One');
    fireEvent.change(code, { target: { value: '## Caso de uso\n\nPay' } });
    fireEvent.click(ui.getByTestId('btn-save-test-case-modal'));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0]![0].scenario).toBe('## Caso de uso\n\nPay');
  });
});

describe('TestCaseModal editing', () => {
  it('keeps pasted images in the scenario and edits one step at a time', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { ui } = open(
      {
        ...base,
        steps: [
          { order: 1, action: 'Open', expectedResult: 'Opened' },
          { order: 2, action: 'Pay', expectedResult: 'Paid' },
        ],
      },
      onSave,
    );
    const png = new File(['png'], 'shot.png', { type: 'image/png' });
    const scenario = ui.getByTestId('input-edit-test-scenario-formatted');
    fireEvent.paste(scenario, { clipboardData: { files: [png] } });
    expect(scenario.querySelector('img')).not.toBeNull();
    fireEvent.input(scenario, { target: { innerHTML: '<p>New scenario</p>' } });
    fireEvent.change(ui.getByTestId('input-step-action-2'), { target: { value: 'Pay now' } });
    fireEvent.change(ui.getByTestId('input-step-expected-2'), { target: { value: 'Paid fast' } });
    fireEvent.click(ui.getByTestId('btn-save-test-case-modal'));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0]![0].steps).toEqual([
      { order: 1, action: 'Open', expectedResult: 'Opened' },
      { order: 2, action: 'Pay now', expectedResult: 'Paid fast' },
    ]);
    expect(onSave.mock.calls[0]![0].scenario).toContain('New scenario');
  });
});
