import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TestSuiteTree } from '../src/features/testplans/TestSuiteTree.js';
import { I18nProvider } from '../src/lib/i18n/index.js';
import type { SavedTestPlanDto, TestSuiteDto } from '../src/lib/api-client.js';

const ISO = '2026-09-18T00:00:00.000Z';

function suite(overrides: Partial<TestSuiteDto> = {}): TestSuiteDto {
  return {
    id: 'suite-root',
    workspaceId: 'ws-1',
    name: 'Regression',
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

function plan(overrides: Partial<SavedTestPlanDto> = {}): SavedTestPlanDto {
  return {
    id: 'plan-1',
    workspaceId: 'ws-1',
    title: 'Checkout',
    plans: [{ title: 'Pay', description: '', steps: [] }],
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

function setup(
  props: Partial<Parameters<typeof TestSuiteTree>[0]> = {},
  locale: 'pt-BR' | 'en-US' = 'en-US',
) {
  const handlers = {
    onCreate: vi.fn().mockResolvedValue(undefined),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onOpenPlan: vi.fn(),
    onDeletePlan: vi.fn(),
    onExportSuite: vi.fn(),
    onPushSuite: vi.fn(),
  };
  const view = render(
    <I18nProvider initialLocale={locale}>
      <TestSuiteTree suites={[]} plans={[]} {...handlers} {...props} />
    </I18nProvider>,
  );
  return { ...view, ...handlers };
}

/** Opens the actions menu whose accessible label matches. */
function openMenu(view: ReturnType<typeof setup>, menuLabel: string) {
  fireEvent.click(view.getByRole('button', { name: menuLabel }));
}

/** Opens the actions menu whose accessible label matches, then clicks the named item inside it. */
function runAction(view: ReturnType<typeof setup>, menuLabel: string, itemName: string) {
  fireEvent.click(view.getByRole('button', { name: menuLabel }));
  fireEvent.click(view.getByRole('button', { name: itemName }));
}

describe('TestSuiteTree rendering', () => {
  it('shows the empty state when there is nothing saved', () => {
    const view = setup();
    expect(view.getByTestId('test-suite-tree')).toBeInTheDocument();
    expect(view.getByText('No Test Plan saved in this workspace.')).toBeInTheDocument();
  });

  it('shows skeletons while loading and hides the empty state', () => {
    const view = setup({ isLoading: true });
    expect(view.getByTestId('test-suites-loading-skeleton')).toBeInTheDocument();
    expect(view.queryByText('No Test Plan saved in this workspace.')).not.toBeInTheDocument();
  });

  it('renders root suites collapsed with their plan count', () => {
    const view = setup({
      suites: [suite()],
      plans: [plan({ suiteId: 'suite-root' }), plan({ id: 'plan-2', suiteId: 'suite-root' })],
    });

    const toggle = view.getByRole('button', { name: 'Regression' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(view.getByText('2')).toBeInTheDocument();
    expect(view.queryByTestId('saved-plan-card-plan-1')).not.toBeInTheDocument();
  });

  it('offers publishing a suite and disables the action while a push is running', () => {
    const view = setup({ suites: [suite()] });
    runAction(view, 'Actions: Regression', 'Publish suite');
    expect(view.onPushSuite).toHaveBeenCalledWith(expect.objectContaining({ id: 'suite-root' }));
    view.rerender(
      <I18nProvider initialLocale="en-US">
        <TestSuiteTree
          suites={[suite()]}
          plans={[]}
          onCreate={view.onCreate}
          onRename={view.onRename}
          onDelete={view.onDelete}
          onOpenPlan={view.onOpenPlan}
          onDeletePlan={view.onDeletePlan}
          onExportSuite={view.onExportSuite}
          onPushSuite={view.onPushSuite}
          pushingSuiteId="suite-root"
        />
      </I18nProvider>,
    );
    openMenu(view, 'Actions: Regression');
    expect(
      (view.getByRole('button', { name: 'Publishing...' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('expands and collapses a suite, revealing its nested suites and plans', () => {
    const view = setup({
      suites: [suite(), suite({ id: 'suite-child', name: 'Checkout', parentId: 'suite-root' })],
      plans: [plan({ suiteId: 'suite-child' })],
    });

    fireEvent.click(view.getByRole('button', { name: 'Regression' }));
    expect(view.getByRole('button', { name: 'Regression' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(view.getByRole('button', { name: 'Checkout' })).toBeInTheDocument();

    fireEvent.click(view.getByRole('button', { name: 'Checkout' }));
    expect(view.getByTestId('saved-plan-card-plan-1')).toBeInTheDocument();
    expect(view.getByText(/1 cases/)).toBeInTheDocument();

    fireEvent.click(view.getByRole('button', { name: 'Regression' }));
    expect(view.queryByTestId('saved-plan-card-plan-1')).not.toBeInTheDocument();
  });

  it('keeps a plan out of a suite it does not belong to', () => {
    const view = setup({ suites: [suite()], plans: [plan({ suiteId: 'other-suite' })] });
    fireEvent.click(view.getByRole('button', { name: 'Regression' }));
    expect(view.queryByTestId('saved-plan-card-plan-1')).not.toBeInTheDocument();
  });
});

describe('TestSuiteTree suite actions', () => {
  it('creates a root suite from the header button', async () => {
    const view = setup();
    fireEvent.click(view.getAllByRole('button', { name: 'New Test Suite' })[0]!);
    fireEvent.change(view.getByRole('textbox'), {
      target: { value: '  Regression  ' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(view.onCreate).toHaveBeenCalledWith('Regression', undefined));
    await waitFor(() => expect(view.queryByRole('textbox')).not.toBeInTheDocument());
  });

  it('creates a nested suite from the suite actions menu', async () => {
    const view = setup({ suites: [suite()] });
    openMenu(view, 'Actions: Regression');
    fireEvent.click(view.getAllByRole('button', { name: 'New Test Suite' }).at(-1)!);
    fireEvent.change(view.getByRole('textbox'), { target: { value: 'Checkout' } });
    fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' });

    await waitFor(() => expect(view.onCreate).toHaveBeenCalledWith('Checkout', 'suite-root'));
  });

  it('renames a suite without calling create', async () => {
    const view = setup({ suites: [suite()] });
    runAction(view, 'Actions: Regression', 'Edit');

    const input = view.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('Regression');
    fireEvent.change(input, { target: { value: 'Smoke' } });
    fireEvent.click(view.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(view.onRename).toHaveBeenCalledWith('suite-root', 'Smoke'));
    expect(view.onCreate).not.toHaveBeenCalled();
  });

  it('ignores a blank name and a key other than Enter', async () => {
    const view = setup();
    fireEvent.click(view.getAllByRole('button', { name: 'New Test Suite' })[0]!);
    fireEvent.change(view.getByRole('textbox'), { target: { value: '   ' } });
    fireEvent.keyDown(view.getByRole('textbox'), { key: 'a' });
    fireEvent.click(view.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(view.onCreate).not.toHaveBeenCalled());
    expect(view.getByRole('textbox')).toBeInTheDocument();
  });

  it('cancels the editor without saving', () => {
    const view = setup();
    fireEvent.click(view.getAllByRole('button', { name: 'New Test Suite' })[0]!);
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }));

    expect(view.queryByRole('textbox')).not.toBeInTheDocument();
    expect(view.onCreate).not.toHaveBeenCalled();
  });

  it('disables creation while a suite is being persisted', async () => {
    const view = setup({ suites: [suite()], isCreating: true });
    expect(
      (view.getAllByRole('button', { name: 'New Test Suite' })[0] as HTMLButtonElement).disabled,
    ).toBe(true);

    openMenu(view, 'Actions: Regression');
    fireEvent.click(view.getAllByRole('button', { name: 'New Test Suite' }).at(-1)!);
    fireEvent.change(view.getByRole('textbox'), { target: { value: 'Checkout' } });
    fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' });

    await waitFor(() => expect(view.onCreate).not.toHaveBeenCalled());
  });

  it('exports and deletes a suite from its actions menu', () => {
    const view = setup({ suites: [suite()] });

    runAction(view, 'Actions: Regression', 'Export suite (.zip)');
    expect(view.onExportSuite).toHaveBeenCalledWith(expect.objectContaining({ id: 'suite-root' }));

    runAction(view, 'Actions: Regression', 'Delete');
    expect(view.onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'suite-root' }));
  });
});

describe('TestSuiteTree plan actions', () => {
  function expanded() {
    const view = setup({ suites: [suite()], plans: [plan({ suiteId: 'suite-root' })] });
    fireEvent.click(view.getByRole('button', { name: 'Regression' }));
    return view;
  }

  it('opens a plan from its title and from the actions menu', () => {
    const view = expanded();

    fireEvent.click(view.getByRole('button', { name: 'Open Test Plan Checkout' }));
    runAction(view, 'Actions: Checkout', 'Edit');

    expect(view.onOpenPlan).toHaveBeenCalledTimes(2);
    expect(view.onOpenPlan).toHaveBeenCalledWith(expect.objectContaining({ id: 'plan-1' }));
  });

  it('deletes a plan from its actions menu', () => {
    const view = expanded();
    fireEvent.click(view.getByRole('button', { name: 'Actions: Checkout' }));
    fireEvent.click(view.getByRole('button', { name: 'Delete Test Plan Checkout' }));

    expect(view.onDeletePlan).toHaveBeenCalledWith(expect.objectContaining({ id: 'plan-1' }));
  });
});

describe('TestSuiteTree localization', () => {
  it('renders the Portuguese labels', () => {
    const view = setup({ suites: [suite()] }, 'pt-BR');
    expect(view.getByRole('button', { name: 'Nova Test Suite' })).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Ações: Regression' })).toBeInTheDocument();
  });
});
