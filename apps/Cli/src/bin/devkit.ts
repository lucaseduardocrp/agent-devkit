#!/usr/bin/env node
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import {
  isServerCommand,
  resolveConfig,
  runServerCommand,
  SERVER_OPTIONS,
  type McpConfig,
} from '#mcp';
import {
  installSkills,
  login,
  logout,
  signedInApi,
  skillTargetDirectory,
  whoami,
  type SkillTarget,
} from '../commands.js';
import { CloudflareTunnelManager } from '../e2e/cloudflare-tunnel.js';
import { createLocalTunnelBridge, LOCAL_BRIDGE_PORT } from '../e2e/local-bridge.js';
import {
  formatRunnerEvent,
  LocalRunnerAgent,
  type LocalOverrides,
} from '../e2e/local-runner/agent.js';
import { LOCAL_CONFIG_FILE, loadLocalConfig } from '../e2e/local-runner/local-config.js';
import {
  createLocalBrowser,
  ensureChromium,
  installChromium,
  loadRunnerIdentity,
  runnerHome,
} from '../e2e/local-runner/playwright-setup.js';
import { runLocally } from '../e2e/local-runner/run-command.js';
import { runHubCommand } from '../hub/command.js';
import { HubInstaller } from '../hub/install.js';
import { packageVersion } from '../version.js';

const HELP = `devkit — ADK command line: sign-in, local E2E runner, tunnels, the ADK Hub and the MCP server

Usage:
  devkit [mcp] [stdio]             Start the local MCP stdio server (default)
  devkit [mcp] http [--port N] [--host H]
                                   Start the MCP Streamable HTTP server (endpoint /mcp)
  devkit [mcp] tools               List the enabled MCP tools
  devkit login [--email E] [--token T]
                                   Sign in and store the session for the stdio server
  devkit logout                    Revoke and forget the stored session
  devkit whoami                    Show the stored session
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

ADK Hub (community skills and plugins):
  devkit skills [search] [QUERY] [--category C]
                                   Browse the hub skills (✓ marks the installed ones)
  devkit skills info NAME          Show a skill's details and source
  devkit skills install NAME... [--client claude|codex|agents] [--scope user|project]
                                   [--dir PATH] [--force]
                                   Download, verify and install skills from the hub
  devkit skills installed | update [NAME...] | remove NAME...
                                   List, update or remove what devkit installed
  devkit plugins search|info|install|installed|update|remove ...
                                   The same for plugins (skills, subagents and MCP servers
                                   from a repository pinned to a reviewed commit; needs git)
  Hub options: --hub-url URL (env ADK_HUB_URL) and --json for machine-readable output.

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
      ...SERVER_OPTIONS,
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
      'hub-url': { type: 'string' },
      category: { type: 'string' },
      force: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  const command = positionals[0] ?? 'stdio';
  if (values.help || command === 'help') return say(HELP);
  if (values.version || command === 'version') return say(packageVersion());

  const config = await resolveConfig(values);

  // The MCP server commands also work without the `mcp` prefix (`devkit` alone starts stdio).
  const serverCommand = command === 'mcp' ? (positionals[1] ?? 'stdio') : command;
  if (isServerCommand(serverCommand)) {
    const server = await runServerCommand(serverCommand, config, say);
    if (server) {
      const stop = () => server.close(() => process.exit(0));
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    }
    return;
  }

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
    case 'install-skills': {
      const client = (values.client ?? 'claude') as SkillTarget;
      if (!['claude', 'codex', 'agents'].includes(client))
        throw new Error(`Unknown client: ${client}`);
      const scope = values.scope === 'project' ? 'project' : 'user';
      const result = await installSkills(values.dir ?? skillTargetDirectory(client, scope));
      return say(`Installed ${result.installed.join(', ')} into ${result.destination}.`);
    }
    case 'skills':
    case 'plugins':
      return runHubCommand(
        command === 'skills' ? 'skill' : 'plugin',
        positionals.slice(1),
        {
          hubUrl: values['hub-url'] ?? process.env['ADK_HUB_URL'],
          client: values.client,
          scope: values.scope,
          dir: values.dir,
          category: values.category,
          force: values.force,
          json: values.json,
        },
        {
          say,
          print: (message) => process.stdout.write(`${message}\n`),
          installer: new HubInstaller({ devkitVersion: packageVersion() }),
        },
      );
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
