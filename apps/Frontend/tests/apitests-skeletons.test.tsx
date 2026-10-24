import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntegrationTestsView } from '../src/features/apitests/IntegrationTestsView.js';
import { LoadTestsView } from '../src/features/apitests/LoadTestsView.js';
import {
  IntegrationTestsSkeleton,
  LoadTestsSkeleton,
} from '../src/features/apitests/ApiTestSkeletons.js';
import type { ApiCollection, LoadScenario } from '../src/features/apitests/api-test-types.js';
import type { ApiClient } from '../src/lib/api-client.js';

/** A promise the test settles when it decides the data has arrived. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

const summary = {
  id: 'c1',
  name: 'Orders API',
  description: '',
  source: { kind: 'manual' },
  requestCount: 1,
  updatedAt: '',
};

const collection: ApiCollection = {
  id: 'c1',
  workspaceId: 'w1',
  name: 'Orders API',
  variables: [],
  auth: { type: 'none' },
  source: { kind: 'manual' },
  updatedAt: '2026-10-24T10:00:00Z',
  items: [
    {
      id: 'list',
      type: 'request',
      name: 'List orders',
      method: 'GET',
      url: '{{baseUrl}}/orders',
      query: [],
      pathParams: [],
      headers: [],
      body: { mode: 'none' },
      auth: { type: 'inherit' },
      captures: [],
      assertions: [],
    },
  ] as ApiCollection['items'],
};

const scenario: LoadScenario = {
  id: 's1',
  name: 'Peak',
  collectionId: 'c1',
  environmentId: null,
  requests: [{ requestId: 'list', weight: 1 }],
  profile: 'load',
  stages: [{ durationSec: 30, targetVus: 10 }],
  thinkTimeMs: 1000,
  thresholds: [],
  updatedAt: '',
};

describe('IntegrationTestsSkeleton', () => {
  it('draws the sidebar, header, tabs, url bar, panes and footer of the screen', () => {
    const view = render(<IntegrationTestsSkeleton />);
    const root = view.getByTestId('integration-tests-skeleton');
    expect(root).toHaveAttribute('role', 'status');
    expect(root).toHaveAttribute('aria-busy', 'true');
    expect(root).toHaveAttribute('aria-label', 'Carregando...');
    // The sidebar keeps its real title and shows tree rows where collections and requests go.
    expect(within(root).getByText('Coleções')).toBeInTheDocument();
    expect(within(root).getAllByTestId('skeleton-tree-row').length).toBeGreaterThanOrEqual(6);
    expect(root.querySelector('header')).not.toBeNull();
    expect(root.querySelector('footer')).not.toBeNull();
    // Everything drawn is a placeholder: nothing can be clicked or typed into.
    expect(root.querySelector('button, input, select, textarea, a')).toBeNull();
  });
});

describe('LoadTestsSkeleton', () => {
  it('draws the scenario list, scenario header, tabs and plan sections', () => {
    const view = render(<LoadTestsSkeleton />);
    const root = view.getByTestId('load-tests-skeleton');
    expect(root).toHaveAttribute('role', 'status');
    expect(root).toHaveAttribute('aria-busy', 'true');
    expect(within(root).getByText('Cenários')).toBeInTheDocument();
    expect(within(root).getAllByTestId('skeleton-scenario-row')).toHaveLength(5);
    expect(within(root).getAllByTestId('skeleton-request-row').length).toBeGreaterThan(0);
    expect(root.querySelector('header')).not.toBeNull();
    expect(root.querySelector('footer')).not.toBeNull();
    expect(root.querySelector('button, input, select, textarea, a')).toBeNull();
  });
});

describe('IntegrationTestsView loading', () => {
  it('shows the skeleton until the collections are listed and the first one is open', async () => {
    const collections = deferred<(typeof summary)[]>();
    const opened = deferred<ApiCollection>();
    const api = {
      listApiCollections: vi.fn(() => collections.promise),
      listApiEnvironments: vi.fn(() => Promise.resolve([])),
      getApiCollection: vi.fn(() => opened.promise),
    };
    const view = render(<IntegrationTestsView apiClient={api as unknown as ApiClient} />);
    expect(view.getByTestId('integration-tests-skeleton')).toBeInTheDocument();
    expect(view.queryByTestId('integration-tests-view')).toBeNull();

    collections.resolve([summary]);
    await waitFor(() => expect(api.getApiCollection).toHaveBeenCalledWith('c1'));
    // The list is in, but the first collection is still opening: the layout does not change yet.
    expect(view.getByTestId('integration-tests-skeleton')).toBeInTheDocument();

    opened.resolve(collection);
    expect(await view.findByTestId('integration-tests-view')).toBeInTheDocument();
    expect(view.queryByTestId('integration-tests-skeleton')).toBeNull();
    expect(view.getByTestId('request-editor')).toBeInTheDocument();
  });

  it('replaces the skeleton by the empty state when there are no collections', async () => {
    const api = {
      listApiCollections: vi.fn(() => Promise.resolve([])),
      listApiEnvironments: vi.fn(() => Promise.resolve([])),
      getApiCollection: vi.fn(),
    };
    const view = render(<IntegrationTestsView apiClient={api as unknown as ApiClient} />);
    expect(view.getByTestId('integration-tests-skeleton')).toBeInTheDocument();
    expect(await view.findByTestId('integration-tests-view')).toBeInTheDocument();
    expect(view.queryByTestId('integration-tests-skeleton')).toBeNull();
    expect(view.getByTestId('create-first')).toBeInTheDocument();
  });

  it('leaves the skeleton and shows the error when the API fails', async () => {
    const api = {
      listApiCollections: vi.fn(() => Promise.reject(new Error('API fora do ar'))),
      listApiEnvironments: vi.fn(() => Promise.resolve([])),
      getApiCollection: vi.fn(),
    };
    const view = render(<IntegrationTestsView apiClient={api as unknown as ApiClient} />);
    expect(await view.findByRole('alert')).toHaveTextContent('API fora do ar');
    expect(view.queryByTestId('integration-tests-skeleton')).toBeNull();
  });

  it('shows skeleton rows under a collection that is still opening in the sidebar', async () => {
    const second = deferred<ApiCollection>();
    const api = {
      listApiCollections: vi.fn(() =>
        Promise.resolve([summary, { ...summary, id: 'c2', name: 'Billing API' }]),
      ),
      listApiEnvironments: vi.fn(() => Promise.resolve([])),
      getApiCollection: vi.fn((id: string) =>
        id === 'c1' ? Promise.resolve(collection) : second.promise,
      ),
    };
    const view = render(<IntegrationTestsView apiClient={api as unknown as ApiClient} />);
    fireEvent.click(await view.findByTestId('collection-Billing API'));
    const sidebar = view.getByTestId('collections-sidebar');
    await waitFor(() =>
      expect(within(sidebar).getAllByTestId('skeleton-tree-row')).toHaveLength(3),
    );
    second.resolve({ ...collection, id: 'c2', name: 'Billing API', items: [] });
    await waitFor(() =>
      expect(within(sidebar).queryAllByTestId('skeleton-tree-row')).toHaveLength(0),
    );
  });
});

describe('LoadTestsView loading', () => {
  function client(collectionLoad: Promise<ApiCollection> = Promise.resolve(collection)) {
    return {
      listLoadScenarios: vi.fn(() => Promise.resolve([scenario])),
      listApiCollections: vi.fn(() => Promise.resolve([summary])),
      listApiEnvironments: vi.fn(() => Promise.resolve([])),
      getApiCollection: vi.fn(() => collectionLoad),
      listApiRuns: vi.fn(() => Promise.resolve([])),
    };
  }

  it('shows the skeleton until the scenarios, collections and environments are listed', async () => {
    const scenarios = deferred<LoadScenario[]>();
    const api = { ...client(), listLoadScenarios: vi.fn(() => scenarios.promise) };
    const view = render(<LoadTestsView apiClient={api as unknown as ApiClient} />);
    expect(view.getByTestId('load-tests-skeleton')).toBeInTheDocument();
    expect(view.queryByTestId('load-tests-view')).toBeNull();

    scenarios.resolve([scenario]);
    expect(await view.findByTestId('load-tests-view')).toBeInTheDocument();
    expect(view.queryByTestId('load-tests-skeleton')).toBeNull();
    expect(view.getByTestId('scenario-Peak')).toBeInTheDocument();
  });

  it('leaves the skeleton and shows the error when the API fails', async () => {
    const api = {
      ...client(),
      listLoadScenarios: vi.fn(() => Promise.reject(new Error('sem rede'))),
    };
    const view = render(<LoadTestsView apiClient={api as unknown as ApiClient} />);
    expect(await view.findByRole('alert')).toHaveTextContent('sem rede');
    expect(view.queryByTestId('load-tests-skeleton')).toBeNull();
  });

  it('shows skeleton request rows while the collection of the scenario is read', async () => {
    const opened = deferred<ApiCollection>();
    const api = client(opened.promise);
    const view = render(<LoadTestsView apiClient={api as unknown as ApiClient} />);
    fireEvent.click(await view.findByTestId('scenario-Peak'));
    const plan = await view.findByTestId('load-plan');
    expect(within(plan).getAllByTestId('skeleton-request-row').length).toBeGreaterThan(0);
    expect(within(plan).queryByText('A coleção não tem requisições.')).toBeNull();

    opened.resolve(collection);
    expect(await within(plan).findByLabelText('List orders')).toBeInTheDocument();
    expect(within(plan).queryAllByTestId('skeleton-request-row')).toHaveLength(0);
  });
});
