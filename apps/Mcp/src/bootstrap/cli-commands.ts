import { cp, mkdir, readFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { HttpAdkClient } from '../api/http-client.js';
import { signInForClient, whoIs, type IssuedCredential } from '../api/credentials.js';
import { FileSessionStore, Session } from '../core/session.js';
import type { McpConfig } from './config.js';
import { loadSkills, skillsDirectory } from './skills.js';

export interface LoginInput {
  readonly token?: string;
  readonly email?: string;
  readonly password?: string;
}

function sessionFor(config: McpConfig): Session {
  return new Session(new FileSessionStore(config.sessionFile), {
    apiUrl: config.apiUrl,
    token: config.token,
    workspaceId: config.workspaceId,
  });
}

/**
 * Signs in and stores the credential in the user-only session file used by the stdio server.
 * With e-mail and password it stores a 90-day personal access token instead of a 7-day session.
 */
export async function login(
  config: McpConfig,
  input: LoginInput,
  fetcher?: typeof fetch,
): Promise<IssuedCredential> {
  const session = sessionFor(config);
  const options = { apiUrl: config.apiUrl, timeoutMs: config.timeoutMs, fetch: fetcher };
  let credential: IssuedCredential;
  if (input.token) {
    credential = {
      token: input.token,
      user: await whoIs(options, input.token),
      expiresAt: null,
      kind: input.token.startsWith('adk_pat_') ? 'access-token' : 'session',
    };
  } else {
    if (!input.email || !input.password) {
      throw new Error('Provide --token, or an e-mail and password.');
    }
    credential = await signInForClient(options, {
      email: input.email,
      password: input.password,
      tokenName: `devkit (${hostname()})`,
    });
  }
  await session.update({
    token: credential.token,
    user: credential.user,
    expiresAt: credential.expiresAt ?? undefined,
  });
  return credential;
}

export async function logout(config: McpConfig, fetcher?: typeof fetch): Promise<void> {
  const session = sessionFor(config);
  const { token } = await session.state();
  if (token) {
    await new HttpAdkClient({
      baseUrl: config.apiUrl,
      timeoutMs: config.timeoutMs,
      fetch: fetcher,
      credentials: () => ({ token }),
    })
      .request({ method: 'POST', path: '/auth/logout', withoutWorkspace: true })
      .catch(() => undefined);
  }
  await session.clear();
}

export async function whoami(config: McpConfig) {
  const state = await sessionFor(config).state();
  return {
    apiUrl: config.apiUrl,
    authenticated: Boolean(state.token),
    user: state.user ?? null,
    expiresAt: state.expiresAt ?? null,
    activeWorkspaceId: state.workspaceId ?? null,
    sessionFile: config.sessionFile,
  };
}

export type SkillTarget = 'claude' | 'codex' | 'agents';

/** Default skill folders per client. `project` installs into the current repository. */
export function skillTargetDirectory(
  target: SkillTarget,
  scope: 'user' | 'project',
  cwd = process.cwd(),
  home = homedir(),
): string {
  const base = scope === 'user' ? home : cwd;
  const folder = { claude: '.claude', codex: '.codex', agents: '.agents' }[target];
  return join(base, folder, 'skills');
}

/** Copies the packaged skills (`skills/<name>/SKILL.md`) into the client's skills folder. */
export async function installSkills(destination: string, source = skillsDirectory()) {
  const target = resolve(destination);
  await mkdir(target, { recursive: true });
  const skills = await loadSkills(source);
  for (const skill of skills) {
    await cp(join(source, skill.name), join(target, skill.name), { recursive: true, force: true });
  }
  return { destination: target, installed: skills.map((skill) => skill.name) };
}

/** API client for terminal commands, signed in with the session stored by `devkit login`. */
export async function signedInApi(
  config: McpConfig,
  userAgent: string,
  fetcher?: typeof fetch,
): Promise<{ api: HttpAdkClient; workspaceId: string | undefined; userName: string | undefined }> {
  const session = sessionFor(config);
  const state = await session.state();
  if (!state.token) throw new Error(`Not signed in to ${config.apiUrl}. Run "devkit login" first.`);
  const api = new HttpAdkClient({
    baseUrl: config.apiUrl,
    timeoutMs: config.timeoutMs,
    fetch: fetcher,
    userAgent,
    credentials: async () => {
      const current = await session.state();
      return { token: current.token, workspaceId: current.workspaceId, locale: config.locale };
    },
  });
  return { api, workspaceId: state.workspaceId, userName: state.user?.name };
}

/**
 * API address saved by the last `devkit login`, so later commands reach the same ADK without
 * repeating --api-url. Explicit --api-url or ADK_API_URL still win.
 */
export async function storedApiUrl(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const file = environment['ADK_MCP_SESSION_FILE'] || join(homedir(), '.adk', 'mcp-session.json');
  try {
    const { apiUrl } = JSON.parse(await readFile(file, 'utf8')) as { apiUrl?: unknown };
    return typeof apiUrl === 'string' && apiUrl ? apiUrl : undefined;
  } catch {
    return undefined;
  }
}
