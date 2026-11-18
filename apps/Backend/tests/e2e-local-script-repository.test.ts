import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompositeScriptRepository } from '../src/modules/e2e/adapters/composite-script-repository.js';
import { LocalScriptRepository } from '../src/modules/e2e/adapters/local-script-repository.js';
import type { E2eRepositoryRef } from '../src/modules/e2e/domain/e2e.js';
import { FakeScriptRepository } from './helpers/fake-script-repository.js';

let folder: string;
const repo = new LocalScriptRepository();
const ref = (overrides: Partial<E2eRepositoryRef> = {}): E2eRepositoryRef => ({
  provider: 'local',
  id: folder,
  name: path.basename(folder),
  branch: 'local',
  path: 'tests/e2e',
  ...overrides,
});

beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-local-specs-'));
});
afterEach(async () => {
  await fs.rm(folder, { recursive: true, force: true });
});

describe('LocalScriptRepository', () => {
  it('reads a folder as a repository, with the branch it has checked out', async () => {
    await expect(repo.resolveFolder(folder)).resolves.toEqual({
      id: folder,
      name: path.basename(folder),
      defaultBranch: 'local',
    });

    await fs.mkdir(path.join(folder, '.git'));
    await fs.writeFile(path.join(folder, '.git', 'HEAD'), 'ref: refs/heads/feature/filtro\n');
    await expect(repo.resolveFolder(folder)).resolves.toMatchObject({
      defaultBranch: 'feature/filtro',
    });
    await expect(repo.listBranches('ws', 'local', folder)).resolves.toEqual([
      { name: 'feature/filtro', isDefault: true },
    ]);

    // A detached HEAD has no branch name to offer.
    await fs.writeFile(
      path.join(folder, '.git', 'HEAD'),
      '0a662dd0a662dd0a662dd0a662dd0a662dd0a662\n',
    );
    await expect(repo.resolveFolder(folder)).resolves.toMatchObject({ defaultBranch: 'local' });

    // A drive root has no name: the path stands in for it.
    const root = path.parse(folder).root;
    await expect(repo.resolveFolder(root)).resolves.toMatchObject({ name: root });
  });

  it('refuses relative paths and folders that do not exist', async () => {
    await expect(repo.resolveFolder('relative/folder')).rejects.toMatchObject({
      code: 'E2E_REPOSITORY_NOT_FOUND',
      statusCode: 400,
    });
    await expect(repo.resolveFolder(path.join(folder, 'missing'))).rejects.toMatchObject({
      code: 'E2E_REPOSITORY_NOT_FOUND',
      statusCode: 404,
    });
    // A file is not a folder.
    await fs.writeFile(path.join(folder, 'a.txt'), 'x');
    await expect(repo.resolveFolder(path.join(folder, 'a.txt'))).rejects.toMatchObject({
      code: 'E2E_REPOSITORY_NOT_FOUND',
    });
  });

  it('lists no hosted repositories and has no link to a file', async () => {
    await expect(repo.listRepositories()).resolves.toEqual({ repositories: [], warnings: [] });
    await expect(repo.fileUrl()).resolves.toBeNull();
  });

  it('writes, reads, lists and deletes specs inside the folder', async () => {
    expect(await repo.listFiles('ws', ref())).toEqual([]);
    expect(await repo.readFile('ws', ref(), 'tests/e2e/TC001.spec.ts')).toBeNull();

    await repo.writeFile('ws', ref(), 'tests/e2e/TC001.spec.ts', 'one', 'msg');
    expect(
      await repo.commitFiles(
        'ws',
        ref(),
        [
          { path: 'tests/e2e/TC002.spec.ts', content: 'two' },
          { path: 'tests/e2e/nested/TC003.spec.ts', content: 'three' },
          { path: 'other/readme.md', content: 'outside the specs folder' },
        ],
        'msg',
      ),
    ).toBeNull();
    // Dependencies and Git internals are never walked.
    await fs.mkdir(path.join(folder, 'tests', 'e2e', 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(folder, 'tests', 'e2e', 'node_modules', 'x.js'), 'x');

    expect(await repo.readFile('ws', ref(), 'tests/e2e/TC001.spec.ts')).toBe('one');
    expect(await repo.listFiles('ws', ref())).toEqual([
      'tests/e2e/TC001.spec.ts',
      'tests/e2e/TC002.spec.ts',
      'tests/e2e/nested/TC003.spec.ts',
    ]);
    // Without a folder of specs, every file of the project is listed.
    expect(await repo.listFiles('ws', ref({ path: '' }))).toContain('other/readme.md');

    await repo.commitFiles('ws', ref(), [{ path: 'tests/e2e/TC002.spec.ts', content: null }], 'rm');
    await repo.commitFiles(
      'ws',
      ref(),
      [{ path: 'tests/e2e/never-existed.ts', content: null }],
      'rm',
    );
    expect(await repo.readFile('ws', ref(), 'tests/e2e/TC002.spec.ts')).toBeNull();
  });

  it('never leaves the folder and surfaces read errors other than a missing file', async () => {
    await expect(repo.readFile('ws', ref(), '../outside.ts')).rejects.toMatchObject({
      code: 'E2E_SCRIPT_PATH_INVALID',
    });
    await expect(repo.writeFile('ws', ref(), '../../outside.ts', 'x', 'm')).rejects.toMatchObject({
      code: 'E2E_SCRIPT_PATH_INVALID',
    });
    await expect(repo.listFiles('ws', ref({ path: '../elsewhere' }))).rejects.toMatchObject({
      code: 'E2E_SCRIPT_PATH_INVALID',
    });
    // The folder itself is a directory, not a file.
    await expect(repo.readFile('ws', ref(), '.')).rejects.toMatchObject({ code: 'EISDIR' });
  });
});

describe('CompositeScriptRepository', () => {
  it('sends each call to the Git host or to the folder that owns the repository', async () => {
    const remote = new FakeScriptRepository();
    const local = {
      listRepositories: vi.fn(),
      listBranches: vi.fn().mockResolvedValue([{ name: 'main', isDefault: true }]),
      listFiles: vi.fn().mockResolvedValue(['a']),
      readFile: vi.fn().mockResolvedValue('content'),
      writeFile: vi.fn().mockResolvedValue(undefined),
      commitFiles: vi.fn().mockResolvedValue(null),
      fileUrl: vi.fn().mockResolvedValue(null),
      resolveFolder: vi.fn().mockResolvedValue({ id: '/p', name: 'p', defaultBranch: 'main' }),
    };
    const composite = new CompositeScriptRepository(remote, local);
    const hosted: E2eRepositoryRef = {
      provider: 'github',
      id: '42',
      name: 'acme/demo-app',
      branch: 'main',
      path: 'tests/e2e',
    };
    const onDisk = ref();

    // Hosted repositories still come from the integrations.
    expect((await composite.listRepositories('ws')).repositories).toHaveLength(2);
    expect(await composite.listBranches('ws', 'github', '42')).toHaveLength(2);
    expect(await composite.listBranches('ws', 'local', folder)).toEqual([
      { name: 'main', isDefault: true },
    ]);

    await composite.writeFile('ws', hosted, 'tests/e2e/a.ts', 'x', 'msg');
    expect(remote.files.size).toBe(1);
    expect(local.writeFile).not.toHaveBeenCalled();
    await composite.commitFiles('ws', hosted, [{ path: 'tests/e2e/b.ts', content: 'y' }], 'msg');
    expect(remote.files.size).toBe(2);
    expect(await composite.readFile('ws', hosted, 'tests/e2e/a.ts')).toBe('x');
    expect(await composite.listFiles('ws', hosted)).toHaveLength(2);
    await composite.fileUrl('ws', hosted, 'tests/e2e/a.ts');

    await composite.writeFile('ws', onDisk, 'tests/e2e/a.ts', 'x', 'msg');
    await composite.commitFiles('ws', onDisk, [{ path: 'tests/e2e/b.ts', content: 'y' }], 'msg');
    expect(await composite.readFile('ws', onDisk, 'tests/e2e/a.ts')).toBe('content');
    expect(await composite.listFiles('ws', onDisk)).toEqual(['a']);
    expect(await composite.fileUrl('ws', onDisk, 'tests/e2e/a.ts')).toBeNull();
    expect(local.writeFile).toHaveBeenCalledTimes(1);
    expect(local.commitFiles).toHaveBeenCalledTimes(1);
    expect(await composite.resolveFolder('/p')).toMatchObject({ name: 'p' });
  });
});
