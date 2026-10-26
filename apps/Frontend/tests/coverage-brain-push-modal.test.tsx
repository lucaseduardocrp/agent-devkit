import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrainPushModal } from '../src/features/brain/BrainPushModal.js';
import {
  ApiClient,
  type KnowledgeDocumentDto,
  type KnowledgePushDestinationDto,
  type KnowledgePushProviderDto,
} from '../src/lib/api-client.js';

const baseDoc: KnowledgeDocumentDto = {
  id: 'child',
  pageId: 'child',
  source: 'app://local?title=Child',
  title: 'Child',
  chunksCount: 1,
  totalCharacters: 1,
  updatedAt: 'now',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup({
  providers = [],
  destinations = [],
  document = baseDoc,
  documents = [baseDoc],
  pushing = false,
  onPush = vi.fn().mockResolvedValue({ success: true }),
}: {
  providers?: readonly KnowledgePushProviderDto[] | Promise<readonly KnowledgePushProviderDto[]>;
  destinations?:
    | readonly KnowledgePushDestinationDto[]
    | (() => Promise<readonly KnowledgePushDestinationDto[]>);
  document?: KnowledgeDocumentDto;
  documents?: readonly KnowledgeDocumentDto[];
  pushing?: boolean;
  onPush?: React.ComponentProps<typeof BrainPushModal>['onPush'];
} = {}) {
  const client = new ApiClient();
  const getProviders = vi
    .spyOn(client, 'getKnowledgePushProviders')
    .mockImplementation(() => Promise.resolve(providers));
  const getDestinations = vi
    .spyOn(client, 'getKnowledgePushDestinations')
    .mockImplementation(() =>
      typeof destinations === 'function' ? destinations() : Promise.resolve(destinations),
    );
  const onClose = vi.fn();
  const view = render(
    <BrainPushModal
      apiClient={client}
      document={document}
      documents={documents}
      pushing={pushing}
      onClose={onClose}
      onPush={onPush}
    />,
  );
  return { view, client, onClose, onPush, getProviders, getDestinations };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BrainPushModal provider loading', () => {
  it('shows a loading option, then explains when no integration is configured', async () => {
    const pending = deferred<readonly KnowledgePushProviderDto[]>();
    const { view, onPush } = setup({ providers: pending.promise });
    const select = view.getByLabelText('Integração') as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(within(select).getByRole('option')).toHaveTextContent('Carregando destinos...');
    pending.resolve([]);
    expect(
      await within(select).findByRole('option', {
        name: 'Configure e ative uma integração compatível na aba Connect.',
      }),
    ).toBeInTheDocument();
    fireEvent.submit(view.container.ownerDocument.querySelector('form')!);
    expect(onPush).not.toHaveBeenCalled();
  });

  it('reports provider loading failures for Error and non-Error rejections', async () => {
    const first = setup({ providers: Promise.reject(new Error('Not allowed')) });
    expect(await first.view.findByRole('alert')).toHaveTextContent('Not allowed');
    first.view.unmount();
    const second = setup({ providers: Promise.reject('offline') });
    expect(await second.view.findByRole('alert')).toHaveTextContent('offline');
  });

  it('ignores provider results that arrive after closing', async () => {
    const resolved = deferred<readonly KnowledgePushProviderDto[]>();
    const first = setup({ providers: resolved.promise });
    first.view.unmount();
    resolved.resolve([{ providerId: 'trello', name: 'Trello', settings: {} }]);
    await resolved.promise;
    expect(first.getDestinations).not.toHaveBeenCalled();

    const rejected = deferred<readonly KnowledgePushProviderDto[]>();
    const second = setup({ providers: rejected.promise });
    second.view.unmount();
    rejected.reject(new Error('late'));
    await rejected.promise.catch(() => undefined);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reports destination loading failures', async () => {
    const { view } = setup({
      providers: [{ providerId: 'trello', name: 'Trello', settings: { boardId: 7 } }],
      destinations: () => Promise.reject(new Error('Board missing')),
    });
    expect(await view.findByRole('alert')).toHaveTextContent('Board missing');
    expect(view.getByText(/Board configurado/).textContent).toBe('Board configurado: ');
  });

  it('reports non-Error destination failures', async () => {
    const { view } = setup({
      providers: [{ providerId: 'trello', name: 'Trello', settings: {} }],
      destinations: () => Promise.reject('timeout'),
    });
    expect(await view.findByRole('alert')).toHaveTextContent('timeout');
  });
});

describe('BrainPushModal Azure DevOps Wiki', () => {
  it('suggests a path from the nearest parent with a remote path', async () => {
    const parent = { ...baseDoc, id: 'p2', pageId: 'p2', title: 'P2', parentPageId: 'p1' };
    const root = { ...baseDoc, id: 'p1', pageId: 'p1', title: 'P1', pagePath: '/Wiki/P1/' };
    const { view } = setup({
      providers: [{ providerId: 'azure_devops_wiki', name: 'Wiki', settings: {} }],
      document: { ...baseDoc, parentPageId: 'p2' },
      documents: [baseDoc, parent, root],
    });
    await view.findByRole('option', { name: 'Wiki' });
    expect((view.getByLabelText('Caminho da pasta ou página pai') as HTMLInputElement).value).toBe(
      '/Wiki/P1/P2',
    );
  });

  it('uses the parent remote path directly and stops at missing parents', async () => {
    const root = { ...baseDoc, id: 'p1', pageId: 'p1', title: 'P1', pagePath: '/Wiki/P1/' };
    const first = setup({
      providers: [{ providerId: 'azure_devops_wiki', name: 'Wiki', settings: {} }],
      document: { ...baseDoc, parentPageId: 'p1' },
      documents: [root],
    });
    await first.view.findByRole('option', { name: 'Wiki' });
    expect(
      (first.view.getByLabelText('Caminho da pasta ou página pai') as HTMLInputElement).value,
    ).toBe('/Wiki/P1');
    first.view.unmount();

    const orphanParent = { ...baseDoc, id: 'p', pageId: 'p', title: 'P', parentPageId: 'gone' };
    const second = setup({
      providers: [{ providerId: 'azure_devops_wiki', name: 'Wiki', settings: {} }],
      document: { ...baseDoc, parentPageId: 'p' },
      documents: [orphanParent],
    });
    await second.view.findByRole('option', { name: 'Wiki' });
    expect(
      (second.view.getByLabelText('Caminho da pasta ou página pai') as HTMLInputElement).value,
    ).toBe('/P');
  });

  it('edits the wiki and parent page and shows the push error', async () => {
    const onPush = vi.fn().mockResolvedValue({ success: false });
    const { view, onClose } = setup({
      providers: [
        { providerId: 'azure_devops_wiki', name: 'Wiki', settings: { wikiIdentifier: 'main' } },
      ],
      destinations: [{ id: '/Docs', label: 'Docs' }],
      onPush,
    });
    await view.findByRole('option', { name: 'Docs' });
    const wiki = view.getByLabelText('Wiki (nome ou ID)') as HTMLInputElement;
    expect(wiki.value).toBe('main');
    fireEvent.change(wiki, { target: { value: 'other' } });
    const parentPage = view.getByLabelText('Página pai na Wiki') as HTMLSelectElement;
    fireEvent.change(parentPage, { target: { value: '/Docs' } });
    expect(parentPage.value).toBe('/Docs');
    expect(view.getByText('Caminho final: /Docs/Child')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Fazer push' }));
    expect(await view.findByRole('alert')).toHaveTextContent('Falha ao publicar o documento.');
    expect(onPush).toHaveBeenCalledWith(
      {
        providerId: 'azure_devops_wiki',
        destination: { parentPath: '/Docs', wikiIdentifier: 'other' },
      },
      'Wiki',
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not submit while a push is running', async () => {
    const { view, onPush } = setup({
      providers: [{ providerId: 'azure_devops_wiki', name: 'Wiki', settings: {} }],
      pushing: true,
    });
    await view.findByRole('option', { name: 'Wiki' });
    fireEvent.submit(view.container.ownerDocument.querySelector('form')!);
    expect(onPush).not.toHaveBeenCalled();
  });
});

describe('BrainPushModal Trello', () => {
  it('accepts a typed list ID and closes after a successful push', async () => {
    const { view, onPush, onClose } = setup({
      providers: [{ providerId: 'trello', name: 'Trello', settings: { boardId: 'board-1' } }],
    });
    expect(await view.findByText('Board configurado: board-1')).toBeInTheDocument();
    const submit = view.getByRole('button', { name: 'Fazer push' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(view.getByLabelText('ID da lista'), { target: { value: 'list-9' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onPush).toHaveBeenCalledWith(
      { providerId: 'trello', destination: { listId: 'list-9' } },
      'Trello',
    );
  });
});

describe('BrainPushModal issue trackers', () => {
  it('sends a GitHub Projects parent item', async () => {
    const { view, onPush } = setup({
      providers: [
        {
          providerId: 'github_projects',
          name: 'GitHub',
          settings: { owner: 'acme', repo: 'app', projectNumber: '4' },
        },
      ],
      destinations: [{ id: 'issue-1', label: 'Epic' }],
    });
    await view.findByRole('option', { name: 'Epic' });
    expect(view.getByText('Projeto configurado: acme/app · #4')).toBeInTheDocument();
    expect(view.queryByLabelText('Tipo do item')).toBeNull();
    fireEvent.change(view.getByLabelText('Item pai'), { target: { value: 'issue-1' } });
    expect((view.getByLabelText('ID do item pai (opcional)') as HTMLInputElement).value).toBe(
      'issue-1',
    );
    fireEvent.click(view.getByRole('button', { name: 'Fazer push' }));
    await waitFor(() =>
      expect(onPush).toHaveBeenCalledWith(
        { providerId: 'github_projects', destination: { parentExternalId: 'issue-1' } },
        'GitHub',
      ),
    );
  });

  it('sends a Jira parent ID and issue type, and shows custom push errors', async () => {
    const onPush = vi.fn().mockResolvedValue({ success: false, error: 'Jira rejected' });
    const { view, getDestinations } = setup({
      providers: [{ providerId: 'jira', name: 'Jira', settings: { projectKey: 'QA' } }],
      onPush,
    });
    expect(await view.findByText('Projeto configurado: QA')).toBeInTheDocument();
    // The provider effect clears the fields before loading destinations; type only after it ran.
    await waitFor(() => expect(getDestinations).toHaveBeenCalledWith('jira'));
    expect(
      view.getByText('Nenhum destino encontrado. Você pode informar o caminho ou ID abaixo.'),
    ).toBeInTheDocument();
    fireEvent.change(view.getByLabelText('ID do item pai (opcional)'), {
      target: { value: 'QA-1' },
    });
    expect((view.getByLabelText('Item pai') as HTMLSelectElement).value).toBe('');
    fireEvent.change(view.getByLabelText('Tipo do item'), { target: { value: 'Story' } });
    fireEvent.click(view.getByRole('button', { name: 'Fazer push' }));
    expect(await view.findByRole('alert')).toHaveTextContent('Jira rejected');
    expect(onPush).toHaveBeenCalledWith(
      { providerId: 'jira', destination: { parentExternalId: 'QA-1', issueType: 'Story' } },
      'Jira',
    );
  });
});
