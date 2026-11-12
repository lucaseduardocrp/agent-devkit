import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { McpServer } from '../core/mcp.js';
import type { CredentialInput } from '../core/types.js';

/** What one user stored for one CLI. */
export interface CliCredentials {
  env: Record<string, string>;
  /** Files for the user's HOME, by relative path. */
  files: Record<string, string>;
}

type Vault = Record<string, Record<string, CliCredentials>>;

const MCP_PREFIX = 'mcp:';

/** The strings inside a JSON file (a login file holds its tokens as values); the text itself otherwise. */
function stringLeaves(content: string): string[] {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') found.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  try {
    walk(JSON.parse(content));
  } catch {
    found.push(content);
  }
  return found;
}

/**
 * The users' CLI credentials, by identity and CLI, encrypted at rest (AES-256-GCM). The file is
 * only readable by the bridge process: the CLIs run as other OS users and never see it.
 */
export class CredentialStore {
  private vault: Vault = {};
  private readonly key: Buffer;

  /** `file` null keeps everything in memory (tests). */
  constructor(
    private readonly file: string | null,
    secret: string,
  ) {
    this.key = Buffer.from(hkdfSync('sha256', secret, 'adk-bridge', 'credentials', 32));
    if (file) this.load(file);
  }

  get(identity: string, cli: string): CliCredentials | undefined {
    return this.vault[identity]?.[cli];
  }

  has(identity: string, cli: string): boolean {
    const found = this.get(identity, cli);
    return Boolean(found && (Object.keys(found.env).length || Object.keys(found.files).length));
  }

  set(identity: string, cli: string, input: CredentialInput): void {
    const entry = ((this.vault[identity] ??= {})[cli] ??= { env: {}, files: {} });
    if (input.kind === 'env') {
      // A new key replaces the old one: a leftover API key would override a subscription token.
      entry.env = { [input.name]: input.value };
    } else {
      entry.files[input.path] = input.content;
    }
    this.save();
  }

  /**
   * MCP servers share the vault under reserved keys (`mcp:<name>`, which no CLI id can have), so
   * the file format stays compatible with vaults written before MCP existed.
   */
  getMcp(identity: string): McpServer[] {
    return Object.entries(this.vault[identity] ?? {})
      .filter(([key, entry]) => key.startsWith(MCP_PREFIX) && entry.env.URL && entry.env.TOKEN)
      .map(([key, entry]) => ({
        name: key.slice(MCP_PREFIX.length),
        url: entry.env.URL!,
        token: entry.env.TOKEN!,
      }));
  }

  setMcp(identity: string, server: McpServer): void {
    (this.vault[identity] ??= {})[`${MCP_PREFIX}${server.name}`] = {
      env: { URL: server.url, TOKEN: server.token },
      files: {},
    };
    this.save();
  }

  /**
   * Every secret value this person holds (keys, tokens, strings inside login files), so they can
   * be masked if a CLI ever prints one.
   */
  secretsOf(identity: string): string[] {
    const secrets: string[] = [];
    for (const entry of Object.values(this.vault[identity] ?? {})) {
      secrets.push(...Object.values(entry.env));
      for (const file of Object.values(entry.files)) secrets.push(...stringLeaves(file));
    }
    return secrets;
  }

  clearMcp(identity: string, name: string): boolean {
    const key = `${MCP_PREFIX}${name}`;
    const existed = Boolean(this.vault[identity]?.[key]);
    if (existed) delete this.vault[identity]![key];
    this.save();
    return existed;
  }

  clear(identity: string, cli: string): boolean {
    const existed = this.has(identity, cli);
    if (this.vault[identity]) delete this.vault[identity][cli];
    this.save();
    return existed;
  }

  private load(file: string): void {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return; // first start
    }
    const { iv, tag, data } = JSON.parse(raw) as { iv: string; tag: string; data: string };
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    try {
      this.vault = JSON.parse(
        Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString(
          'utf8',
        ),
      ) as Vault;
    } catch {
      // A wrong key must not silently start an empty vault and overwrite the real one.
      throw new Error(
        'The credentials file cannot be decrypted: BRIDGE_ENCRYPTION_KEY changed. Restore the key, or delete the file to start over.',
      );
    }
  }

  private save(): void {
    if (!this.file) return;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(this.vault), 'utf8'), cipher.final()]);
    const body = JSON.stringify({
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    });
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, body, { mode: 0o600 });
    renameSync(temp, this.file);
    chmodSync(this.file, 0o600);
  }
}
