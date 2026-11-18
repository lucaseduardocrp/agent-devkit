import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryUserIntegrationStore } from '../src/modules/integrations/adapters/in-memory-integrations-store.js';
import { DynamicProviderFactory } from '../src/modules/integrations/application/dynamic-provider-factory.js';
import { IntegrationsService } from '../src/modules/integrations/application/integrations-service.js';

const detect = vi.hoisted(() => vi.fn());
const complete = vi.hoisted(() => vi.fn());
const account = vi.hoisted(() => vi.fn());

vi.mock('../src/modules/agents/adapters/cli-llm/cli-llm.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../src/modules/agents/adapters/cli-llm/cli-llm.js')>();
  class FakeCliLlmProvider extends original.CliLlmProvider {
    public override complete = complete;
  }
  return {
    ...original,
    detectCli: detect,
    cliAccount: account,
    CliLlmProvider: FakeCliLlmProvider,
  };
});

describe('Testing an LLM integration in AI CLI mode', () => {
  const previous = process.env['ADK_LLM_CLI'];
  const factory = () =>
    new DynamicProviderFactory(new IntegrationsService(new InMemoryUserIntegrationStore()));
  const probe = (providerId = 'claude', settings: Record<string, unknown> = { authMode: 'cli' }) =>
    factory().testConnectivity(providerId, 'LLM', settings);

  beforeEach(() => {
    process.env['ADK_LLM_CLI'] = 'true';
    detect.mockReset();
    complete.mockReset();
    account.mockReset();
    account.mockResolvedValue(null);
  });
  afterEach(() => {
    if (previous === undefined) delete process.env['ADK_LLM_CLI'];
    else process.env['ADK_LLM_CLI'] = previous;
  });

  it('proves the CLI is installed and signed in with a real answer', async () => {
    detect.mockResolvedValue({
      id: 'claude',
      label: 'Claude',
      command: 'claude',
      installed: true,
      version: '2.1.318',
    });
    complete.mockResolvedValue({ provider: 'Claude CLI', text: 'OK' });
    expect(await probe()).toEqual({ ok: true, message: 'Claude CLI 2.1.318 answered.' });
    expect(complete).toHaveBeenCalledOnce();
  });

  it('says which account answers, and for which login folder it asked', async () => {
    process.env['ADK_CLI_PROFILES_DIR'] = join(tmpdir(), 'adk-test-profiles');
    const dir = join(tmpdir(), 'adk-test-profiles', 'ws-1', 'claude', 'work');
    detect.mockResolvedValue({ id: 'claude', label: 'Claude', command: 'claude', installed: true });
    account.mockResolvedValue('me@example.com · pro');
    complete.mockResolvedValue({ provider: 'Claude CLI', text: 'OK' });
    const settings = { authMode: 'cli', cliProfile: 'work' };
    const test = () =>
      factory().testConnectivity(
        'claude',
        'LLM',
        settings,
        undefined,
        undefined,
        undefined,
        'ws-1',
      );
    try {
      expect(await test()).toEqual({
        ok: true,
        message: 'Claude CLI answered. Account: me@example.com · pro.',
      });
      expect(account).toHaveBeenCalledWith('claude', dir);

      complete.mockRejectedValueOnce(new Error('Credit balance is too low'));
      expect(await test()).toEqual({
        ok: false,
        message: 'Credit balance is too low Account: me@example.com · pro.',
      });
    } finally {
      delete process.env['ADK_CLI_PROFILES_DIR'];
    }
  });

  it('names the CLI without a version when it does not print one', async () => {
    detect.mockResolvedValue({ id: 'codex', label: 'Codex', command: 'codex', installed: true });
    complete.mockResolvedValue({ provider: 'Codex CLI', text: 'OK' });
    expect(await probe('openai')).toEqual({ ok: true, message: 'Codex CLI answered.' });
  });

  it('fails without calling the model when the CLI is not installed', async () => {
    detect.mockResolvedValue({
      id: 'claude',
      label: 'Claude',
      command: 'claude',
      installed: false,
    });
    const result = await probe();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('not installed');
    expect(complete).not.toHaveBeenCalled();
  });

  it('fails when the CLI answers nothing or cannot answer', async () => {
    detect.mockResolvedValue({ id: 'claude', label: 'Claude', command: 'claude', installed: true });
    complete.mockResolvedValueOnce({ provider: 'Claude CLI', text: '   ' });
    expect((await probe()).ok).toBe(false);

    complete.mockRejectedValueOnce(new Error('Claude CLI is not signed in on the server.'));
    expect(await probe()).toEqual({
      ok: false,
      message: 'Claude CLI is not signed in on the server.',
    });

    complete.mockRejectedValueOnce('exploded');
    expect(await probe()).toEqual({ ok: false, message: 'The CLI failed.' });
  });

  it('reports a disabled server or a provider without a CLI as a failed test', async () => {
    delete process.env['ADK_LLM_CLI'];
    const disabled = await probe();
    expect(disabled.ok).toBe(false);
    expect(disabled.message).toContain('ADK_LLM_CLI=true');

    process.env['ADK_LLM_CLI'] = 'true';
    const unsupported = await probe('groq');
    expect(unsupported.ok).toBe(false);
    expect(detect).not.toHaveBeenCalled();
  });

  it('leaves API-key mode and other categories to their own probes', async () => {
    const apiKey = await factory().testConnectivity(
      'openai',
      'LLM',
      { model: 'gpt-4o' },
      undefined,
      vi.fn(),
    );
    expect(apiKey.ok).toBe(false); // no key: the API-key probe asked for one
    expect(detect).not.toHaveBeenCalled();

    const knowledge = await factory().testConnectivity(
      'wiki_js',
      'KNOWLEDGE',
      { authMode: 'cli' },
      undefined,
      vi.fn(),
    );
    expect(knowledge.ok).toBe(false);
    expect(detect).not.toHaveBeenCalled();
  });
});
