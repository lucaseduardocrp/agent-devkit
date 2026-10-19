import { describe, expect, it } from 'vitest';
import { InMemoryPbiStore } from '../src/modules/pbi/pbi-store.js';

describe('InMemoryPbiStore missing items', () => {
  it('returns null when updating an unknown or foreign item', async () => {
    const store = new InMemoryPbiStore();
    const foreign = await store.create('other', { kind: 'pbi', title: 'Elsewhere' });
    expect(await store.update('ws', 'missing', { title: 'X' })).toBeNull();
    expect(await store.update('ws', foreign.id, { title: 'X' })).toBeNull();
    expect((await store.get('other', foreign.id))?.title).toBe('Elsewhere');
  });

  it('returns false when removing an unknown or foreign item', async () => {
    const store = new InMemoryPbiStore();
    const foreign = await store.create('other', { kind: 'pbi', title: 'Elsewhere' });
    expect(await store.remove('ws', 'missing')).toBe(false);
    expect(await store.remove('ws', foreign.id)).toBe(false);
    expect(await store.list('other')).toHaveLength(1);
  });

  it('rejects links to unknown items', async () => {
    const store = new InMemoryPbiStore();
    await expect(
      store.link('ws', 'missing', {
        providerId: 'jira',
        externalId: '1',
        externalUrl: null,
        boardId: null,
      }),
    ).rejects.toThrow('PBI item not found');
  });
});
