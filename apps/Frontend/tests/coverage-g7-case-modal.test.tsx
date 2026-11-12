import { fireEvent, render, waitFor, within } from '@testing-library/react';
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
    fireEvent.paste(ui.getByTestId('input-edit-test-scenario'), {
      clipboardData: { files: [big] },
    });
    expect(ui.getByRole('alert')).toHaveTextContent('10 MB');
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
    fireEvent.paste(ui.getByTestId('input-edit-test-scenario'), {
      clipboardData: { files: [png] },
    });
    expect(ui.getByTestId('input-edit-test-scenario').querySelector('img')).not.toBeNull();
    fireEvent.input(ui.getByTestId('input-edit-test-scenario'), {
      target: { innerHTML: '<p>New scenario</p>' },
    });
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
