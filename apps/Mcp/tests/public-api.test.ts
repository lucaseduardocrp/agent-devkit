import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

/** The `devkit` CLI (apps/Cli) depends on these exports of @agent-devkit/mcp. */
describe('public API', () => {
  it('exports what the CLI uses', () => {
    expect(Object.keys(api).sort()).toEqual([
      'AdkApiError',
      'FileSessionStore',
      'HttpAdkClient',
      'MemorySessionStore',
      'SERVER_COMMANDS',
      'SERVER_NAME',
      'SERVER_OPTIONS',
      'Session',
      'isServerCommand',
      'loadConfig',
      'loadSkills',
      'localOrigin',
      'mcpVersion',
      'quickTunnelCommand',
      'resolveConfig',
      'runServerCommand',
      'segment',
      'signInForClient',
      'skillsDirectory',
      'storedApiUrl',
      'whoIs',
    ]);
  });
});
