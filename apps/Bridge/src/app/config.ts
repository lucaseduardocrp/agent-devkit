import { parseCustomClis, type CustomCliSpec } from '../cli/custom.js';
import type { Autonomy } from '../core/types.js';
import type { Lang } from './messages.js';

export interface BridgeConfig {
  /** Standalone mode: the Bridge polls its own Telegram bot (do not share the ADK's bot). */
  readonly telegramToken: string | null;
  /** ADK mode: the ADK API forwards chats here and receives the replies. */
  readonly sharedToken: string | null;
  readonly adkUrl: string;
  readonly httpPort: number;
  /** Users who may talk to the bridge. Empty: nobody (fail closed). */
  readonly allowedUserIds: ReadonlySet<string>;
  readonly defaultCli: string;
  readonly defaultMode: Autonomy;
  /** Parent of every user's private project directory. */
  readonly workdir: string;
  /** Parent of every user's private HOME (where the CLIs keep their login). */
  readonly homesDir: string;
  /** Chats, tasks, users and encrypted credentials. Only the bridge can read it. */
  readonly dataDir: string;
  /** Encrypts the users' credentials. Changing it makes the saved ones unreadable. */
  readonly encryptionKey: string | null;
  readonly runTimeoutMs: number;
  readonly lang: Lang;
  readonly customClis: readonly CustomCliSpec[];
}

export function loadConfig(env: NodeJS.ProcessEnv): BridgeConfig {
  const mode = (env.BRIDGE_DEFAULT_MODE || 'auto').toLowerCase();
  if (mode !== 'safe' && mode !== 'auto')
    throw new Error('BRIDGE_DEFAULT_MODE must be "safe" or "auto".');
  const timeout = Number(env.BRIDGE_RUN_TIMEOUT_MS || 30 * 60_000);
  if (!Number.isFinite(timeout) || timeout < 1000)
    throw new Error('BRIDGE_RUN_TIMEOUT_MS must be a number of milliseconds (at least 1000).');
  const ids = (env.BRIDGE_ALLOWED_USER_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const bad = ids.find((id) => !/^\d+$/.test(id));
  if (bad) throw new Error(`BRIDGE_ALLOWED_USER_IDS has "${bad}": use numeric Telegram user ids.`);
  return {
    telegramToken: env.TELEGRAM_BOT_TOKEN?.trim() || null,
    sharedToken: env.BRIDGE_SHARED_TOKEN?.trim() || null,
    adkUrl: env.BRIDGE_ADK_URL?.trim() || 'http://api:3000',
    // Platforms such as Railway route their public domain to $PORT, so honor it when set.
    httpPort: Number(env.BRIDGE_HTTP_PORT || env.PORT || 3500),
    allowedUserIds: new Set(ids),
    defaultCli: (env.BRIDGE_DEFAULT_CLI || 'claude').toLowerCase(),
    defaultMode: mode,
    workdir: env.BRIDGE_WORKDIR || '/workspace',
    homesDir: env.BRIDGE_HOMES_DIR || '/homes',
    dataDir: env.BRIDGE_DATA_DIR || '/data',
    encryptionKey:
      env.BRIDGE_ENCRYPTION_KEY?.trim() ||
      env.BRIDGE_SHARED_TOKEN?.trim() ||
      env.TELEGRAM_BOT_TOKEN?.trim() ||
      null,
    runTimeoutMs: timeout,
    lang: env.BRIDGE_LANG?.toLowerCase().startsWith('en') ? 'en' : 'pt',
    customClis: parseCustomClis(env.BRIDGE_CUSTOM_CLIS),
  };
}
