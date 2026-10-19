#!/usr/bin/env node
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { ToolRegistry } from '../core/registry.js';
import { modules } from '../modules/index.js';
import { loadConfig, parseToolsets } from '../bootstrap/config.js';
import {
  installSkills,
  login,
  logout,
  signedInApi,
  storedApiUrl,
  skillTargetDirectory,
  whoami,
  type SkillTarget,
} from '../bootstrap/cli-commands.js';
import {
  formatRunnerEvent,
  LocalRunnerAgent,
  type LocalOverrides,
} from '../modules/e2e/local-runner/agent.js';
import { LOCAL_CONFIG_FILE, loadLocalConfig } from '../modules/e2e/local-runner/local-config.js';
import {
  createLocalBrowser,
  ensureChromium,
  installChromium,
  loadRunnerIdentity,
  runnerHome,
} from '../modules/e2e/local-runner/playwright-setup.js';
import { runLocally } from '../modules/e2e/local-runner/run-command.js';
import type { McpConfig } from '../bootstrap/config.js';
import { packageVersion } from '../bootstrap/create-server.js';
import { loadSkills } from '../bootstrap/skills.js';
import { createHttpServer, startStdio } from '../bootstrap/transports.js';
import { CloudflareTunnelManager } from '../modules/e2e/cloudflare-tunnel.js';
import { createLocalTunnelBridge, LOCAL_BRIDGE_PORT } from '../modules/e2e/local-bridge.js';

const HELP = `devkit — ADK command line: MCP server, local E2E runner and tunnels

Usage:
  devkit [stdio]                   Start the local stdio server (default)
  devkit http [--port N] [--host H]
                                   Start the Streamable HTTP server (endpoint /mcp)
  devkit login [--email E] [--token T]
                                   Sign in and store the session for the stdio server
  devkit logout                    Revoke and forget the stored session
  devkit whoami                    Show the stored session
  devkit tools                     List the enabled tools
  devkit tunnel --url http://localhost:5173
                                   Expose a local app and the other localhost services it
                                   calls (APIs, SSO) with Cloudflare Tunnel until Ctrl+C
  devkit bridge --origin https://your-adk.vercel.app
                                   Let the ADK web app control local tunnels
  devkit runner [--run ID] [--base-url URL]
                                   Run the browser of your local E2E runs on this computer
                                   (outbound HTTPS only, no tunnel) until Ctrl+C
  devkit e2e setup                 Download Chromium ahead of time (otherwise done on first use)
  devkit e2e run [ID] [--test TC001] [--base-url URL] [--scripts DIR] [--set-local]
                                   Start a run, execute it here and send the results,
                                   videos and screenshots to ADK. Defaults come from
                                   ./adk-e2e.json ({ "run", "baseUrl", "scripts" }).
                                   ADK_E2E_USERNAME / ADK_E2E_PASSWORD override the account.
  devkit install-skills --client claude|codex|agents [--scope user|project] [--dir PATH]
                                   Copy the ADK skills into a client's skills folder

Common options:
  --api-url URL        ADK API base URL (env ADK_API_URL, default http://localhost:3000)
  --toolsets a,b       Enabled toolsets (env ADK_MCP_TOOLSETS)
  --read-only          Expose only read tools (env ADK_MCP_READ_ONLY)
`;

// stdout is reserved for the MCP protocol in stdio mode, so all human output goes to stderr.
const say = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

async function ask(question: string, hidden = false): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (!muted) process.stderr.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY });
  const pending = rl.question(question);
  muted = hidden;
  const answer = await pending;
  rl.close();
  if (hidden) say('');
  return answer.trim();
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      'api-url': { type: 'string' },
      toolsets: { type: 'string' },
      'read-only': { type: 'boolean' },
      port: { type: 'string' },
      host: { type: 'string' },
      url: { type: 'string' },
      origin: { type: 'string' },
      email: { type: 'string' },
      token: { type: 'string' },
      client: { type: 'string' },
      scope: { type: 'string' },
      dir: { type: 'string' },
      run: { type: 'string' },
      test: { type: 'string' },
      'base-url': { type: 'string' },
      scripts: { type: 'string' },
      'set-local': { type: 'boolean' },
      config: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  const command = positionals[0] ?? 'stdio';
  if (values.help || command === 'help') return say(HELP);
  if (values.version || command === 'version') return say(packageVersion());

  // Without --api-url or ADK_API_URL, use the API of the last login (not the localhost default).
  const apiUrl =
    values['api-url'] ?? (process.env['ADK_API_URL'] ? undefined : await storedApiUrl());
  const config = loadConfig({
    ...process.env,
    ...(apiUrl ? { ADK_API_URL: apiUrl } : {}),
    ...(values.toolsets ? { ADK_MCP_TOOLSETS: values.toolsets } : {}),
    ...(values['read-only'] ? { ADK_MCP_READ_ONLY: 'true' } : {}),
    ...(values.port ? { ADK_MCP_HTTP_PORT: values.port } : {}),
    ...(values.host ? { ADK_MCP_HTTP_HOST: values.host } : {}),
  });
  const registry = new ToolRegistry(modules, {
    toolsets: parseToolsets(values.toolsets ?? process.env['ADK_MCP_TOOLSETS']),
    readOnly: config.readOnly,
  });

  switch (command) {
    case 'bridge': {
      if (!values.origin) throw new Error('Pass --origin https://your-adk-frontend.');
      const tunnel = new CloudflareTunnelManager();
      const server = createLocalTunnelBridge(values.origin, tunnel);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(LOCAL_BRIDGE_PORT, '127.0.0.1', resolve);
      });
      say(
        `[devkit] Local tunnel helper ready for ${values.origin}. Leave it running while using ADK.`,
      );
      const stop = () => {
        tunnel.stop();
        server.close();
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      return;
    }
    case 'tunnel': {
      if (!values.url) throw new Error('Pass --url http://localhost:<port>.');
      const tunnel = new CloudflareTunnelManager();
      const info = await tunnel.start(values.url, true);
      say('[devkit] Tunnel ready. Fill in E2E Automation → Application:');
      say(`  Base URL                 ${info.publicUrl}`);
      say(`  Original local address   ${info.localUrl}`);
      say(`  Access Client ID         ${info.accessClientId ?? ''}`);
      say(`  Access Client Secret     ${info.accessClientSecret ?? ''}`);
      say(
        '[devkit] Browser requests to other localhost ports (APIs, SSO) are routed to this computer too. Keep this terminal and the application running. Press Ctrl+C to close the tunnel.',
      );
      const stop = () => tunnel.stop();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      await tunnel.waitForClose();
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      return;
    }
    case 'runner': {
      const { agent, signal } = await localAgent(config, {
        ...(values['base-url'] ? { baseUrl: values['base-url'] } : {}),
      });
      say(
        '[devkit] Waiting for E2E tests set to run on this computer. Keep this terminal open; press Ctrl+C to stop.',
      );
      await agent.serve({ ...(values.run ? { creationId: values.run } : {}), signal });
      return;
    }
    case 'e2e': {
      const action = positionals[1];
      if (action === 'setup') {
        process.exitCode = await installChromium();
        if (!process.exitCode) say('[devkit] Chromium is ready for local E2E runs.');
        return;
      }
      if (action !== 'run') throw new Error('Use "devkit e2e setup" or "devkit e2e run <id>".');
      const local = await loadLocalConfig(resolve(values.config ?? LOCAL_CONFIG_FILE));
      const creationId = positionals[2] ?? local.run;
      if (!creationId) throw new Error(`Pass the run id or set "run" in ${LOCAL_CONFIG_FILE}.`);
      const baseUrl = values['base-url'] ?? local.baseUrl;
      const scripts = values.scripts ? resolve(values.scripts) : local.scripts;
      const { api, agent, signal } = await localAgent(config, baseUrl ? { baseUrl } : {});
      const summary = await runLocally(
        api,
        agent,
        {
          creationId,
          ...(values.test ? { test: values.test } : {}),
          ...(scripts ? { scriptsDir: scripts } : {}),
          ...(values['set-local'] ? { setLocal: true } : {}),
          signal,
        },
        say,
      );
      say(
        `[devkit] ${summary.passed} passed, ${summary.failed} failed. Results, videos and screenshots are in ADK.`,
      );
      if (summary.failed || summary.creation.status !== 'completed') process.exitCode = 1;
      return;
    }
    case 'stdio':
      await startStdio(config, registry, await loadSkills());
      say(`[devkit] stdio server ready (${registry.tools.length} tools, API ${config.apiUrl}).`);
      return;
    case 'http': {
      const server = createHttpServer(config, registry, await loadSkills());
      server.listen(config.http.port, config.http.host, () =>
        say(
          `[devkit] HTTP server on http://${config.http.host}:${config.http.port}/mcp (${registry.tools.length} tools, API ${config.apiUrl}, auth ${config.http.requireAuth ? 'required' : 'optional'}).`,
        ),
      );
      const stop = () => server.close(() => process.exit(0));
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      return;
    }
    case 'login': {
      const token = values.token;
      const email = token ? undefined : (values.email ?? (await ask('E-mail: ')));
      const password = token ? undefined : await ask('Password: ', true);
      const credential = await login(config, { token, email, password });
      say(
        `Signed in to ${config.apiUrl} as ${credential.user.name} <${credential.user.email}> with a ${credential.kind === 'access-token' ? 'personal access token' : 'session token'}${credential.expiresAt ? ` valid until ${credential.expiresAt}` : ''}. Saved to ${config.sessionFile}.`,
      );
      return;
    }
    case 'logout':
      await logout(config);
      return say('Signed out.');
    case 'whoami':
      return say(JSON.stringify(await whoami(config), null, 2));
    case 'tools':
      for (const tool of registry.tools) {
        say(
          `${tool.name.padEnd(34)} ${tool.toolset.padEnd(13)} ${tool.access.padEnd(12)} ${tool.execution}`,
        );
      }
      return;
    case 'install-skills': {
      const client = (values.client ?? 'claude') as SkillTarget;
      if (!['claude', 'codex', 'agents'].includes(client))
        throw new Error(`Unknown client: ${client}`);
      const scope = values.scope === 'project' ? 'project' : 'user';
      const result = await installSkills(values.dir ?? skillTargetDirectory(client, scope));
      return say(`Installed ${result.installed.join(', ')} into ${result.destination}.`);
    }
    default:
      say(HELP);
      process.exitCode = 1;
  }
}

/**
 * Signed-in runner for this computer. The first Ctrl+C stops the browser and the loop;
 * a second one exits immediately.
 */
async function localAgent(config: McpConfig, overrides: LocalOverrides) {
  const version = packageVersion();
  const { api, workspaceId, userName } = await signedInApi(config, `devkit/${version}`);
  const identity = await loadRunnerIdentity(runnerHome(), version);
  await ensureChromium(say);
  const username = process.env['ADK_E2E_USERNAME'];
  const password = process.env['ADK_E2E_PASSWORD'];
  const agent = new LocalRunnerAgent({
    api,
    browser: await createLocalBrowser(),
    identity,
    overrides: {
      ...overrides,
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
    },
    onEvent: (event) => say(formatRunnerEvent(event)),
  });
  const controller = new AbortController();
  process.on('SIGINT', () => {
    if (controller.signal.aborted) process.exit(130);
    say('[devkit] Stopping… press Ctrl+C again to exit now.');
    controller.abort();
  });
  say(
    `[devkit] Runner "${identity.name}" signed in${userName ? ` as ${userName}` : ''} at ${config.apiUrl}${workspaceId ? ` (workspace ${workspaceId})` : ''}.`,
  );
  return { api, agent, signal: controller.signal };
}

main().catch((error: unknown) => {
  say(`[devkit] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
