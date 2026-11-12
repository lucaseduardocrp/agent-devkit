import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shellCommand, Terminal, type TerminalEvent } from '../src/main/terminal.js';

describe('shellCommand', () => {
  it('uses PowerShell on Windows and the shell of the user elsewhere', () => {
    const windows = shellCommand('ls', 'win32', {});
    expect(windows.command).toBe('powershell.exe');
    expect(windows.args.at(-1)).toContain('ls; $adkOk = $?; if ($LASTEXITCODE)');
    expect(shellCommand('ls', 'linux', { SHELL: '/bin/zsh' })).toEqual({
      command: '/bin/zsh',
      args: ['-c', 'ls'],
    });
    expect(shellCommand('ls', 'darwin', {}).command).toBe('/bin/sh');
  });
});

describe('Terminal', () => {
  let root = '';
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'adk-terminal-')));
    await mkdir(join(root, 'sub folder'));
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  function terminal(options: ConstructorParameters<typeof Terminal>[2] = {}) {
    const events: TerminalEvent[] = [];
    const instance = new Terminal(root, (event) => events.push(event), options);
    const exited = (count = 1) =>
      vi.waitFor(
        () => expect(events.filter((event) => event.type === 'exit')).toHaveLength(count),
        { timeout: 20_000 },
      );
    const output = () =>
      events.map((event) => (event.type === 'output' ? event.text : '')).join('');
    return { instance, events, exited, output };
  }
  // The same line works in PowerShell and in sh.
  const node = (script: string) => `node -e "${script}"`;

  it('runs a command in the folder and reports its output and exit code', async () => {
    const { instance, events, exited, output } = terminal();
    expect(await instance.run(node('console.log(process.cwd()); process.exit(3)'))).toBe(true);
    await exited();
    expect(output()).toContain(root);
    expect(events.at(-1)).toEqual({ type: 'exit', code: 3, cwd: root });
  }, 30_000);

  it('follows cd and treats an empty line as done', async () => {
    const { instance, events } = terminal();
    await instance.run('   ');
    await instance.run('cd "sub folder"');
    expect(instance.folder).toBe(join(root, 'sub folder'));
    await instance.run('cd missing');
    await instance.run('cd ..');
    expect(events).toEqual([
      { type: 'exit', code: 0, cwd: root },
      { type: 'exit', code: 0, cwd: join(root, 'sub folder') },
      { type: 'output', text: 'cd: missing: no such folder\n' },
      { type: 'exit', code: 1, cwd: join(root, 'sub folder') },
      { type: 'exit', code: 0, cwd: root },
    ]);
  });

  it('runs one command at a time and stops it with what it started', async () => {
    const { instance, exited } = terminal();
    instance.stop();
    expect(await instance.run(node('setInterval(() => {}, 1000)'))).toBe(true);
    expect(await instance.run('echo no')).toBe(false);
    instance.stop();
    await exited();
    expect(await instance.run('cd .')).toBe(true);
  }, 30_000);

  it('stops through the given function and reports a shell that cannot start', async () => {
    const kill = vi.fn();
    const stoppable = terminal({ kill });
    await stoppable.instance.run(node('setTimeout(() => {}, 300)'));
    stoppable.instance.stop();
    expect(kill).toHaveBeenCalledTimes(1);
    await stoppable.exited();

    const broken = terminal({
      platform: 'linux',
      shell: () => ({ command: 'adk-no-such-shell', args: [] }),
    });
    await broken.instance.run('ls');
    await broken.exited();
    expect(broken.output()).toContain('adk-no-such-shell');
    expect(broken.events.at(-1)).toEqual({ type: 'exit', code: 1, cwd: root });
  }, 30_000);
});
