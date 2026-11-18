import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cliLoginCommand,
  cliProfilePath,
  createCliProfile,
  deleteCliProfile,
  isValidProfileName,
  listCliProfiles,
} from '../src/modules/agents/adapters/cli-llm/cli-profiles.js';

describe('CLI profiles', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'adk-profiles-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates and lists the accounts of one CLI in one workspace, sorted', async () => {
    await createCliProfile('ws-1', 'claude', 'work', root);
    await createCliProfile('ws-1', 'claude', 'personal', root);
    await createCliProfile('ws-2', 'claude', 'other', root);
    await createCliProfile('ws-1', 'codex', 'codex-1', root);

    expect((await listCliProfiles('ws-1', 'claude', root)).map((p) => p.name)).toEqual([
      'personal',
      'work',
    ]);
    expect((await listCliProfiles('ws-1', 'codex', root)).map((p) => p.name)).toEqual(['codex-1']);
    expect(await listCliProfiles('ws-9', 'claude', root)).toEqual([]);
  });

  it('deletes one account and its login folder, and only that one', async () => {
    const work = await createCliProfile('ws-1', 'claude', 'work', root);
    await createCliProfile('ws-1', 'claude', 'personal', root);
    await writeFile(join(work.path, '.credentials.json'), '{}');

    await deleteCliProfile('ws-1', 'claude', 'work', root);

    expect((await listCliProfiles('ws-1', 'claude', root)).map((p) => p.name)).toEqual([
      'personal',
    ]);
    // Already gone is not an error.
    await expect(deleteCliProfile('ws-1', 'claude', 'work', root)).resolves.toBeUndefined();
    // Never a path out of the profiles folder, and never a CLI without a login folder.
    await expect(deleteCliProfile('ws-1', 'claude', '..', root)).rejects.toMatchObject({
      code: 'LLM_CLI_PROFILE_INVALID',
    });
    await expect(deleteCliProfile('ws-1', 'gemini', 'x', root)).rejects.toMatchObject({
      code: 'LLM_CLI_PROFILES_UNSUPPORTED',
    });
  });

  it('never builds a path from anything but a plain name', () => {
    for (const bad of ['', '..', '../x', 'a/b', 'a\\b', 'a b', '-x', 'x'.repeat(33), 'a;b']) {
      expect(isValidProfileName(bad)).toBe(false);
      expect(() => cliProfilePath('ws', 'claude', bad, root)).toThrow();
    }
    expect(cliProfilePath('ws/../x', 'claude', 'ok', root)).toBe(
      join(root, 'ws____x', 'claude', 'ok'),
    );
  });

  it('has no profiles for a CLI without a login folder', async () => {
    expect(await listCliProfiles('ws', 'gemini', root)).toEqual([]);
    await expect(createCliProfile('ws', 'gemini', 'x', root)).rejects.toMatchObject({
      code: 'LLM_CLI_PROFILES_UNSUPPORTED',
    });
  });

  it('writes the login command for the platform', () => {
    expect(cliLoginCommand('claude', 'C:\\p\\a', 'win32')).toBe(
      'cmd /c "set CLAUDE_CONFIG_DIR=C:\\p\\a&& claude /login"',
    );
    expect(cliLoginCommand('codex', '/p/a', 'linux')).toBe('CODEX_HOME="/p/a" codex login');
    expect(cliLoginCommand('gemini', '/p/a', 'linux')).toBe('');
  });
});
