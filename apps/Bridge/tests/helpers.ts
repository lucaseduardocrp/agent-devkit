import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../src/app/bridge.js';
import { loadConfig } from '../src/app/config.js';
import { CredentialStore } from '../src/app/credential-store.js';
import { Sandbox } from '../src/app/sandbox.js';
import { StateStore } from '../src/app/state-store.js';
import { createCliRegistry } from '../src/cli/index.js';
import { CliExecutor } from '../src/core/cli-registry.js';
import type { ProcessRunner } from '../src/core/process-runner.js';
import type { Channel, IncomingMessage, Invocation, MessageHandler } from '../src/core/types.js';

export class FakeChannel implements Channel {
  readonly id = 'telegram';
  maxMessageLength = 4096;
  trusted = false;
  sent: string[] = [];
  handler!: MessageHandler;
  async start(handler: MessageHandler): Promise<void> {
    this.handler = handler;
  }
  async send(_chatId: string, text: string): Promise<void> {
    this.sent.push(text);
  }
  async indicateBusy(): Promise<void> {}
}

export function message(text: string, userId = '1', isPrivate = true): IncomingMessage {
  return { channel: 'telegram', chatId: userId, userId, text, isPrivate };
}

export function setup(run: ProcessRunner, env: NodeJS.ProcessEnv = {}) {
  const config = loadConfig({ BRIDGE_ALLOWED_USER_IDS: '1', BRIDGE_LANG: 'en', ...env });
  const channel = new FakeChannel();
  const root = mkdtempSync(join(tmpdir(), 'bridge-test-'));
  const credentials = new CredentialStore(null, 'test-key');
  // The default test user is signed in to every CLI, like someone who ran /auth already.
  for (const cli of ['claude', 'codex', 'gemini'])
    credentials.set('telegram:1', cli, { kind: 'env', name: 'TEST_KEY', value: 'k' });
  const calls: Invocation[] = [];
  const envs: (NodeJS.ProcessEnv | undefined)[] = [];
  const bridge = new Bridge({
    config,
    channels: [channel],
    registry: createCliRegistry(config.customClis),
    executor: new CliExecutor({
      timeoutMs: 5000,
      run: (invocation, options) => {
        calls.push(invocation);
        envs.push(options.env);
        void options.uid;
        return run(invocation, options);
      },
    }),
    store: new StateStore(null),
    credentials,
    sandbox: new Sandbox({
      homesDir: join(root, 'homes'),
      workspacesDir: join(root, 'work'),
      usersFile: null,
      credentials,
      switchUser: false,
    }),
  });
  return { bridge, channel, calls, envs, config, credentials, root };
}
