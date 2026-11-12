import {
  appendFileSync,
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { safeEnv } from '../core/process-runner.js';
import type { CredentialStore } from './credential-store.js';

/** Where and as whom a user's CLI runs. */
export interface UserRuntime {
  readonly home: string;
  readonly cwd: string;
  /** Set when the CLI runs as its own OS user. */
  readonly uid?: number;
  readonly gid?: number;
  /** The CLI's complete environment: HOME and this user's credentials, nothing else secret. */
  readonly env: Record<string, string>;
}

export interface SandboxOptions {
  /** One private HOME per user, e.g. /homes/<n>. */
  readonly homesDir: string;
  /** One private project directory per user, e.g. /workspace/<n>. */
  readonly workspacesDir: string;
  /** Remembers which number belongs to which user. Owned by the bridge only. */
  readonly usersFile: string | null;
  readonly credentials: CredentialStore;
  /**
   * Give every user their own OS user (uid) with 0700 directories, so one user's CLI cannot
   * read another's files or credentials. Needs the bridge to run as root.
   */
  readonly switchUser: boolean;
  /** Passwd and group files to register the users in (tools such as git look them up). */
  readonly passwdFile?: string;
  readonly groupFile?: string;
}

const FIRST_UID = 20_000;

/** True when the process can create OS users' files and switch to them (root on Linux). */
export function canSwitchUser(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/**
 * Prepares the private space of each user: HOME, project directory, OS user and the
 * credentials of the CLI about to run. Users never share a directory, a uid or a credential.
 */
export class Sandbox {
  private users: { next: number; byIdentity: Record<string, number> } = {
    next: 1,
    byIdentity: {},
  };

  constructor(private readonly options: SandboxOptions) {
    if (options.usersFile) {
      try {
        this.users = JSON.parse(readFileSync(options.usersFile, 'utf8')) as typeof this.users;
      } catch {
        // first start
      }
    }
  }

  /** `managedFiles`: files the CLI needs this run (its MCP config), rewritten every time. */
  resolve(
    identity: string,
    cli: string,
    managedFiles: Record<string, (current: string | null) => string> = {},
  ): UserRuntime {
    const number = this.numberOf(identity);
    const uid = this.options.switchUser ? FIRST_UID + number : undefined;
    const home = join(this.options.homesDir, String(number));
    const cwd = join(this.options.workspacesDir, String(number));
    for (const dir of [home, cwd]) this.prepareDirectory(dir, uid);
    if (uid !== undefined) this.registerOsUser(uid, number, home);

    const credentials = this.options.credentials.get(identity, cli);
    for (const [path, content] of Object.entries(credentials?.files ?? {}))
      this.materialize(home, path, content, uid);

    for (const [path, produce] of Object.entries(managedFiles))
      this.writeManaged(home, path, produce, uid);

    return {
      home,
      cwd,
      uid,
      gid: uid,
      env: {
        ...safeEnv(),
        HOME: home,
        USER: `u${number}`,
        LOGNAME: `u${number}`,
        ...credentials?.env,
      },
    };
  }

  private numberOf(identity: string): number {
    const known = this.users.byIdentity[identity];
    if (known) return known;
    const number = this.users.next++;
    this.users.byIdentity[identity] = number;
    if (this.options.usersFile) {
      mkdirSync(dirname(this.options.usersFile), { recursive: true });
      const temp = `${this.options.usersFile}.tmp`;
      writeFileSync(temp, JSON.stringify(this.users));
      renameSync(temp, this.options.usersFile);
    }
    return number;
  }

  private prepareDirectory(dir: string, uid: number | undefined): void {
    mkdirSync(dir, { recursive: true });
    if (uid === undefined) return;
    chownSync(dir, uid, uid);
    chmodSync(dir, 0o700);
  }

  private registerOsUser(uid: number, number: number, home: string): void {
    const passwd = this.options.passwdFile ?? '/etc/passwd';
    const group = this.options.groupFile ?? '/etc/group';
    try {
      if (!readFileSync(passwd, 'utf8').includes(`:x:${uid}:`))
        appendFileSync(passwd, `u${number}:x:${uid}:${uid}::${home}:/bin/bash\n`);
      if (!readFileSync(group, 'utf8').includes(`:x:${uid}:`))
        appendFileSync(group, `u${number}:x:${uid}:\n`);
    } catch {
      // The CLIs still run: only tools that look the user up by name would complain.
    }
  }

  /** Writes a file the bridge owns into the user's HOME (0600), replacing its content. */
  private writeManaged(
    home: string,
    path: string,
    produce: (current: string | null) => string,
    uid: number | undefined,
  ): void {
    const target = join(home, path);
    const inside = relative(home, target);
    if (inside.startsWith('..') || isAbsolute(inside)) return; // never outside the HOME
    mkdirSync(dirname(target), { recursive: true });
    let current: string | null = null;
    try {
      current = readFileSync(target, 'utf8');
    } catch {
      // not there yet
    }
    writeFileSync(target, produce(current), { mode: 0o600 });
    if (uid !== undefined) {
      chownSync(dirname(target), uid, uid);
      chownSync(target, uid, uid);
    }
  }

  /** Writes a credential file into the user's HOME once; the CLI refreshes it afterwards. */
  private materialize(home: string, path: string, content: string, uid: number | undefined) {
    const target = join(home, path);
    const inside = relative(home, target);
    if (inside.startsWith('..') || isAbsolute(inside)) return; // never outside the HOME
    if (existsSync(target)) return;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { mode: 0o600 });
    if (uid !== undefined) {
      chownSync(dirname(target), uid, uid);
      chownSync(target, uid, uid);
    }
  }
}
