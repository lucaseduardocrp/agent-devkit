import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AuthModal } from '../src/features/auth/AuthModal.js';
import { ApiClient } from '../src/lib/api-client.js';

type Options = Awaited<ReturnType<ApiClient['getAuthOptions']>>;

describe('AuthModal sign-in providers', () => {
  it('ignores the provider list that arrives after the modal closed', async () => {
    const client = new ApiClient();
    let resolve: (options: Options) => void = () => {};
    vi.spyOn(client, 'getAuthOptions').mockImplementation(
      () => new Promise<Options>((r) => (resolve = r)),
    );
    const view = render(
      <AuthModal isOpen onClose={vi.fn()} onSuccess={vi.fn()} apiClient={client} />,
    );
    await waitFor(() => expect(client.getAuthOptions).toHaveBeenCalled());
    view.rerender(
      <AuthModal isOpen={false} onClose={vi.fn()} onSuccess={vi.fn()} apiClient={client} />,
    );
    resolve({ oauthProviders: ['google'] } as Options);
    await new Promise((done) => setTimeout(done, 0));
    expect(view.queryByRole('button', { name: /Google/ })).toBeNull();
  });

  it('ignores a provider list failure that arrives after the modal closed', async () => {
    const client = new ApiClient();
    let reject: (reason: Error) => void = () => {};
    vi.spyOn(client, 'getAuthOptions').mockImplementation(
      () => new Promise<Options>((_, fail) => (reject = fail)),
    );
    const view = render(
      <AuthModal isOpen onClose={vi.fn()} onSuccess={vi.fn()} apiClient={client} />,
    );
    await waitFor(() => expect(client.getAuthOptions).toHaveBeenCalled());
    view.unmount();
    reject(new Error('offline'));
    await new Promise((done) => setTimeout(done, 0));
    expect(client.getAuthOptions).toHaveBeenCalledTimes(1);
  });
});

describe('AuthModal provider failure while open', () => {
  it('shows no social sign-in when the options cannot be loaded', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getAuthOptions').mockRejectedValue(new Error('offline'));
    const view = render(
      <AuthModal isOpen onClose={vi.fn()} onSuccess={vi.fn()} apiClient={client} />,
    );
    await waitFor(() => expect(client.getAuthOptions).toHaveBeenCalled());
    await new Promise((done) => setTimeout(done, 0));
    expect(view.queryByRole('button', { name: /Google|GitHub/ })).toBeNull();
  });
});
