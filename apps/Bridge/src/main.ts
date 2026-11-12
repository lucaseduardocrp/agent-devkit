import { chmodSync, mkdirSync, utimesSync, closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { Bridge } from './app/bridge.js';
import { loadConfig } from './app/config.js';
import { CredentialStore } from './app/credential-store.js';
import { canSwitchUser, Sandbox } from './app/sandbox.js';
import { StateStore } from './app/state-store.js';
import { createCliRegistry } from './cli/index.js';
import { AdkChannel } from './channels/adk/adk-channel.js';
import { TelegramChannel } from './channels/telegram/telegram-channel.js';
import { CliExecutor } from './core/cli-registry.js';
import type { Channel } from './core/types.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  const registry = createCliRegistry(config.customClis);
  if (!registry.get(config.defaultCli))
    throw new Error(`BRIDGE_DEFAULT_CLI "${config.defaultCli}" is not one of the available CLIs.`);

  if (!config.encryptionKey)
    throw new Error(
      'Set BRIDGE_ENCRYPTION_KEY (or BRIDGE_SHARED_TOKEN): it encrypts the credentials.',
    );
  mkdirSync(config.workdir, { recursive: true });
  mkdirSync(config.homesDir, { recursive: true });
  mkdirSync(config.dataDir, { recursive: true });
  // Chats, tasks and the credentials file: never readable by the users' CLIs, wherever the
  // directory is mounted (a single Railway volume holds all three).
  chmodSync(config.dataDir, 0o700);
  const switchUser = canSwitchUser();
  if (!switchUser)
    console.warn(
      '[Bridge] Not running as root: users share one OS user, so their CLIs can read each other files. Run the container as root (the default image) for isolation.',
    );
  const credentials = new CredentialStore(
    join(config.dataDir, 'credentials.enc'),
    config.encryptionKey,
  );
  const sandbox = new Sandbox({
    homesDir: config.homesDir,
    workspacesDir: config.workdir,
    usersFile: join(config.dataDir, 'users.json'),
    credentials,
    switchUser,
  });
  // The channels are the only chat-app specific part: add another one here.
  const channels: Channel[] = [];
  if (config.sharedToken)
    channels.push(
      new AdkChannel({
        port: config.httpPort,
        token: config.sharedToken,
        apiUrl: config.adkUrl,
        listClis: () => registry.list().map((a) => a.id),
      }),
    );
  if (config.telegramToken) {
    channels.push(new TelegramChannel({ token: config.telegramToken }));
    if (!config.allowedUserIds.size)
      console.warn(
        '[Bridge] BRIDGE_ALLOWED_USER_IDS is empty: nobody can use the standalone bot. Send /whoami to it.',
      );
  }
  if (!channels.length)
    throw new Error('Set BRIDGE_SHARED_TOKEN (ADK mode) or TELEGRAM_BOT_TOKEN (standalone).');
  const bridge = new Bridge({
    config,
    channels,
    registry,
    executor: new CliExecutor({ timeoutMs: config.runTimeoutMs }),
    store: new StateStore(join(config.dataDir, 'state.json')),
    credentials,
    sandbox,
  });

  // The container healthcheck reads the age of this file.
  const heartbeat = join(config.dataDir, 'heartbeat');
  const beat = (): void => {
    const now = new Date();
    try {
      utimesSync(heartbeat, now, now);
    } catch {
      closeSync(openSync(heartbeat, 'w'));
    }
  };
  beat();
  const timer = setInterval(beat, 30_000);

  const shutdown = (): void => {
    clearInterval(timer);
    bridge.stop();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  console.log(
    `[Bridge] Online. CLIs: ${registry
      .list()
      .map((a) => a.id)
      .join(', ')}. Default: ${config.defaultCli}/${config.defaultMode}.`,
  );
  if (config.sharedToken) console.log(`[Bridge] HTTP API for the ADK on port ${config.httpPort}.`);
  await bridge.start();
}

main().catch((error: unknown) => {
  const errorName = error instanceof Error ? error.name : 'UnknownError';
  console.error(`[Bridge] Startup failed (${errorName}).`);
  process.exit(1);
});
