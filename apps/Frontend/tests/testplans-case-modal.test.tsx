import { fireEvent, render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestCaseModal } from '../src/features/testplans/TestCaseModal.js';
import {
  sanitizeRichText,
  testCaseFields,
  testCaseOrigin,
} from '../src/features/testplans/test-case-fields.js';
import type { TestCase } from '../src/features/testplans/TestPlansView.js';

const imported: TestCase = {
  id: 'CT-01',
  caseId: 'case-1',
  title: 'Pay with card',
  scenario: '<p>Pay the <b>cart</b></p><img src=x onerror="alert(1)">',
  steps: [{ order: 1, action: 'Open the cart', expectedResult: 'Cart shown' }],
  metadata: {
    caseId: 'case-1',
    importedFrom: 'azure_devops',
    remoteCaseIds: { azure_devops: '50605' },
    remoteCaseLocations: { azure_devops: { planId: '10', suiteId: '20' } },
    remoteUrls: { azure_devops: 'https://dev.azure.com/acme/QA/_workitems/edit/50605' },
    importedAt: '2026-10-14T12:00:00.000Z',
    customFields: {
      azure_devops: {
        'Custom.Risk': 'High',
        'System.State': 'Design',
        'Custom.Automated': true,
        'Custom.Notes': '<div onclick="steal()">Use a <b>test</b> card</div>',
        'Custom.Empty': '',
        'Custom.Unknown': null,
      },
    },
    customFieldLabels: { azure_devops: { 'Custom.Risk': 'Risk', 'System.State': 'State' } },
  },
};

beforeEach(() => {
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => true) });
});
afterEach(() => vi.restoreAllMocks());

describe('test case fields', () => {
  it('reads the origin of an imported case', () => {
    expect(testCaseOrigin(imported.metadata)).toEqual({
      provider: 'azure_devops',
      providerName: 'Azure Test Plans',
      caseId: '50605',
      planId: '10',
      suiteId: '20',
      url: 'https://dev.azure.com/acme/QA/_workitems/edit/50605',
      importedAt: '2026-10-14T12:00:00.000Z',
    });
    expect(testCaseOrigin(undefined)).toBeNull();
    expect(testCaseOrigin({ remoteCaseIds: { testrail: '' } })).toBeNull();
    // A case published to a platform (not imported) still knows where it lives.
    expect(testCaseOrigin({ remoteCaseIds: { custom: '7' } })).toMatchObject({
      provider: 'custom',
      providerName: 'custom',
      planId: '',
      url: null,
      importedAt: null,
    });
  });

  it('lists the provider fields with their labels, leaving empty ones out', () => {
    expect(
      testCaseFields(imported.metadata, 'azure_devops').map((field) => [
        field.label,
        field.value,
        field.html,
      ]),
    ).toEqual([
      ['Custom.Automated', '✓', false],
      ['Custom.Notes', '<div onclick="steal()">Use a <b>test</b> card</div>', true],
      ['Risk', 'High', false],
      ['State', 'Design', false],
    ]);
    expect(
      testCaseFields({ customFields: { x: { off: false, list: ['a'] } } }, 'x').map(
        (field) => field.value,
      ),
    ).toEqual(['✗']);
    expect(testCaseFields(undefined, 'x')).toEqual([]);
  });

  it('keeps only basic formatting in rich text', () => {
    expect(
      sanitizeRichText(
        '<p/onmouseover=alert(1) class="x">Hi</p><script>alert(1)</script><style>p{}</style>' +
          '<a href="javascript:alert(1)">link</a><ul><li id="a">One</li></ul><br/>',
      ),
    ).toBe('<p>Hi</p>link<ul><li>One</li></ul><br>');
  });
});

describe('TestCaseModal', () => {
  function modal(props: Partial<Parameters<typeof TestCaseModal>[0]> = {}) {
    const onSave = vi.fn();
    const onClose = vi.fn();
    const ui = render(
      <TestCaseModal
        testCase={imported}
        planTitle="Checkout"
        onSave={onSave}
        onClose={onClose}
        {...props}
      />,
    );
    return { ui, onSave, onClose };
  }

  it('shows the origin and every provider field of an imported case', () => {
    const { ui } = modal();
    const window = ui.getByTestId('test-case-modal');
    expect(within(window).getByText('Ação')).toBeInTheDocument();
    expect(within(window).getByText('Resultado esperado')).toBeInTheDocument();
    expect(window).toHaveTextContent('Caso de teste · CT-01 · Azure Test Plans #50605');
    expect(window).toHaveTextContent('Test Plan Checkout');
    const fields = ui.getByTestId('test-case-provider-fields');
    expect(within(fields).getByText('Risk').nextSibling).toHaveTextContent('High');
    expect(within(fields).getByText('State').nextSibling).toHaveTextContent('Design');
    // Rich text values are shown formatted, without handlers.
    const notes = within(fields).getByText('Custom.Notes').nextElementSibling!;
    expect(notes.innerHTML).toBe('<div>Use a <b>test</b> card</div>');
    expect(ui.getByRole('link', { name: 'Abrir no provedor' })).toHaveAttribute(
      'href',
      'https://dev.azure.com/acme/QA/_workitems/edit/50605',
    );
    expect(ui.getByText('50605')).toBeInTheDocument();
    expect(ui.getByTestId('input-edit-test-scenario').innerHTML).toBe('<p>Pay the <b>cart</b></p>');
  });

  it('saves the edited case and starts an E2E run for it', () => {
    const onAutomate = vi.fn();
    const { ui, onSave } = modal({ onAutomate });
    fireEvent.change(ui.getByTestId('input-edit-test-title'), { target: { value: 'Pay by Pix' } });
    fireEvent.change(ui.getByTestId('input-step-expected-1'), { target: { value: 'Cart open' } });
    fireEvent.click(ui.getByTestId('btn-save-test-case-modal'));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Pay by Pix',
        steps: [{ order: 1, action: 'Open the cart', expectedResult: 'Cart open' }],
        metadata: imported.metadata,
      }),
    );
    fireEvent.click(ui.getByRole('button', { name: 'Automatizar com E2E' }));
    expect(onAutomate).toHaveBeenCalled();
  });

  it('only shows the case to members who cannot edit', () => {
    const { ui, onClose } = modal({ readOnly: true });
    expect(ui.queryByTestId('btn-save-test-case-modal')).toBeNull();
    expect(ui.queryByTestId('btn-add-step')).toBeNull();
    expect(ui.queryByRole('button', { name: 'Negrito' })).toBeNull();
    expect((ui.getByTestId('input-edit-test-title') as HTMLInputElement).disabled).toBe(true);
    expect(ui.getByTestId('input-edit-test-scenario')).toHaveAttribute('aria-readonly', 'true');
    fireEvent.click(ui.getByRole('button', { name: 'Fechar' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('starts a case without steps from an empty list', () => {
    const { ui, onSave } = modal({
      testCase: { id: 'CT-03', title: 'Draft', scenario: '' },
    });
    fireEvent.click(ui.getByTestId('btn-add-step'));
    fireEvent.change(ui.getByTestId('input-step-action-1'), { target: { value: 'Open' } });
    fireEvent.click(ui.getByRole('button', { name: 'Remover passo 1' }));
    fireEvent.click(ui.getByTestId('btn-save-test-case-modal'));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ steps: [] }));
  });

  it('marks cases written in ADK and imported cases without fields', () => {
    const local = modal({
      testCase: { id: 'CT-02', title: 'Local', scenario: '', steps: [] },
      planTitle: undefined,
    });
    expect(local.ui.getAllByText('Criado no ADK').length).toBeGreaterThan(0);
    expect(local.ui.queryByText('Campos do provedor')).toBeNull();
    local.ui.unmount();

    const bare = modal({
      testCase: {
        ...imported,
        metadata: { remoteCaseIds: { testrail: '30' }, importedFrom: 'testrail' },
      },
    });
    expect(bare.ui.getByText('Este caso não tem campos do provedor.')).toBeInTheDocument();
    expect(bare.ui.queryByRole('link', { name: 'Abrir no provedor' })).toBeNull();
  });
});
