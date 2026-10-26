import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { ResizableSidebar } from '../src/components/layout/ResizableSidebar.js';
import { Topbar } from '../src/components/layout/Topbar.js';
import { parseInlineTokens } from '../src/components/ui/formatted-content.js';
import type { UserProfile } from '../src/features/auth/auth-types.js';
import { ApiClient } from '../src/lib/api-client.js';

const ana: UserProfile = { id: 'usr-1', name: 'Ana', email: 'ana@example.com', createdAt: '' };

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function sessionClient(): ApiClient {
  const client = new ApiClient();
  vi.spyOn(client, 'getHealth').mockResolvedValue({ status: 'ok', requestId: 'req-1' });
  vi.spyOn(client, 'getWorkspaces').mockResolvedValue([]);
  return client;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('adk_locale', 'pt-BR');
  localStorage.setItem('adk_token', 'stored-token');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('App session check', () => {
  it('ignores a profile that arrives after the app was closed', async () => {
    const client = sessionClient();
    const me = deferred<UserProfile>();
    vi.spyOn(client, 'getMe').mockReturnValue(me.promise);
    const view = render(<App apiClient={client} />);
    view.unmount();
    await act(async () => me.resolve(ana));
    expect(client.getWorkspaces).not.toHaveBeenCalled();
  });

  it('keeps the stored token when the session check fails after the app was closed', async () => {
    const client = sessionClient();
    const me = deferred<UserProfile>();
    vi.spyOn(client, 'getMe').mockReturnValue(me.promise);
    const view = render(<App apiClient={client} />);
    view.unmount();
    await act(async () => me.reject(new Error('expired')));
    expect(localStorage.getItem('adk_token')).toBe('stored-token');
  });

  it('signs out locally even when the server logout fails', async () => {
    const client = sessionClient();
    vi.spyOn(client, 'getMe').mockResolvedValue(ana);
    const logout = vi.spyOn(client, 'logout').mockRejectedValue(new Error('offline'));
    const view = render(<App apiClient={client} />);

    fireEvent.click(await view.findByRole('button', { name: 'Perfil: Ana' }));
    fireEvent.click(view.getByTestId('topbar-menu-logout'));

    expect(await view.findByTestId('auth-modal')).toBeInTheDocument();
    await waitFor(() => expect(logout).toHaveBeenCalled());
    expect(localStorage.getItem('adk_token')).toBeNull();
  });
});

describe('Topbar menu', () => {
  it('stays open for clicks inside the menu and keys other than Escape', () => {
    const view = render(
      <Topbar activeTab="brain" isAuthenticated userName="Ana" onLogout={vi.fn()} />,
    );
    fireEvent.click(view.getByTestId('topbar-user-menu-button'));
    const dropdown = view.getByTestId('topbar-user-dropdown');
    fireEvent.mouseDown(dropdown);
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(view.getByTestId('topbar-user-dropdown')).toBeInTheDocument();
  });
});

describe('ResizableSidebar collapse', () => {
  const pointerEvent = (type: string, properties: { button?: number; clientX?: number } = {}) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.entries(properties).forEach(([key, value]) => {
      Object.defineProperty(event, key, { value });
    });
    return event;
  };

  it('does not fold an already folded sidebar again when it is dropped small', () => {
    const onCollapse = vi.fn();
    const onExpand = vi.fn();
    const view = render(
      <ResizableSidebar
        data-testid="sidebar"
        defaultWidth={240}
        minWidth={200}
        collapsed
        collapsedWidth={64}
        onCollapse={onCollapse}
        onExpand={onExpand}
      >
        Content
      </ResizableSidebar>,
    );
    const handle = view.getByRole('separator', { name: 'Redimensionar barra lateral' });
    fireEvent(handle, pointerEvent('pointerdown', { button: 0, clientX: 64 }));
    fireEvent(window, pointerEvent('pointermove', { clientX: 70 }));
    act(() => {
      window.dispatchEvent(pointerEvent('pointerup'));
    });
    expect(onCollapse).not.toHaveBeenCalled();
    expect(onExpand).not.toHaveBeenCalled();
  });
});

describe('parseInlineTokens links', () => {
  it('splits a markdown link into its label and address', () => {
    expect(parseInlineTokens('see [docs](https://example.com/a?b=1)')).toEqual([
      { type: 'text', content: 'see ' },
      { type: 'link', content: 'docs', href: 'https://example.com/a?b=1' },
    ]);
  });
});
