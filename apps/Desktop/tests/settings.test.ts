import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  completeSettings,
  newSecret,
  readSettingsFile,
  writeSettingsFile,
  type DesktopSettings,
} from '../src/main/settings.js';

const keepPreferred = (preferred: number, taken: readonly number[]) =>
  Promise.resolve(taken.includes(preferred) ? preferred + 1 : preferred);

describe('completeSettings', () => {
  it('generates every secret and uses the preferred ports on a first launch', async () => {
    const settings = await completeSettings({}, keepPreferred, () => 'a'.repeat(64));
    expect(settings).toEqual({
      apiPort: 3000,
      mcpPort: 3333,
      databasePort: 54329,
      integrationEncryptionKey: 'a'.repeat(64),
      oauthStateSecret: 'a'.repeat(64),
      mcpOauthSecret: 'a'.repeat(64),
      databasePassword: 'a'.repeat(64),
    });
  });

  it('keeps saved secrets and ports, and replaces secrets that are too short', async () => {
    const saved = {
      apiPort: 4100,
      integrationEncryptionKey: 'k'.repeat(64),
      databasePassword: 'short',
    };
    const settings = await completeSettings(saved, keepPreferred, () => 'n'.repeat(40));
    expect(settings.apiPort).toBe(4100);
    expect(settings.integrationEncryptionKey).toBe('k'.repeat(64));
    expect(settings.databasePassword).toBe('n'.repeat(40));
  });

  it('ignores a saved port that is not a number and passes the ports already taken', async () => {
    const seen: (readonly number[])[] = [];
    await completeSettings({ apiPort: '3000' }, (preferred, taken) => {
      seen.push([...taken]);
      return Promise.resolve(preferred);
    });
    expect(seen).toEqual([[], [3000], [3000, 3333]]);
  });

  it('creates 64-character hex secrets by default', () => {
    expect(newSecret()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('settings file', () => {
  const settings: DesktopSettings = {
    apiPort: 1,
    mcpPort: 2,
    databasePort: 3,
    integrationEncryptionKey: 'a'.repeat(64),
    oauthStateSecret: 'b'.repeat(64),
    mcpOauthSecret: 'c'.repeat(64),
    databasePassword: 'd'.repeat(64),
  };

  it('writes and reads back, creating the folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adk-settings-'));
    const file = join(dir, 'nested', 'settings.json');
    await writeSettingsFile(file, settings);
    expect(await readSettingsFile(file)).toEqual(settings);
  });

  it('reads a missing, corrupt or non-object file as empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adk-settings-'));
    expect(await readSettingsFile(join(dir, 'missing.json'))).toEqual({});
    const corrupt = join(dir, 'corrupt.json');
    await writeFile(corrupt, '{nope');
    expect(await readSettingsFile(corrupt)).toEqual({});
    const list = join(dir, 'list.json');
    await writeFile(list, 'null');
    expect(await readSettingsFile(list)).toEqual({});
    expect(await readFile(corrupt, 'utf8')).toBe('{nope');
  });
});

describe('cloud database settings', () => {
  const cloudDatabase = { url: 'safe:abc', integrationEncryptionKey: 'c'.repeat(64) };

  it('keeps a saved cloud database', async () => {
    const settings = await completeSettings({ cloudDatabase }, keepPreferred);
    expect(settings.cloudDatabase).toEqual(cloudDatabase);
  });

  it.each([
    ['nothing', undefined],
    ['not an object', 'postgresql://u:p@h/d'],
    ['null', null],
    ['no key', { url: 'safe:abc' }],
    ['an empty url', { url: '', integrationEncryptionKey: 'k' }],
    ['an empty key', { url: 'safe:abc', integrationEncryptionKey: '' }],
  ])('drops a cloud database with %s', async (_label, value) => {
    const settings = await completeSettings({ cloudDatabase: value }, keepPreferred);
    expect(settings).not.toHaveProperty('cloudDatabase');
  });
});
