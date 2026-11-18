import { CliRegistry } from '../core/cli-registry.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { createCustomAdapter, type CustomCliSpec } from './custom.js';
import { geminiAdapter } from './gemini.js';

/** The built-in CLIs plus the ones described in the configuration. To add a CLI, register it here. */
export function createCliRegistry(custom: readonly CustomCliSpec[] = []): CliRegistry {
  const registry = new CliRegistry()
    .register(claudeAdapter)
    .register(codexAdapter)
    .register(geminiAdapter);
  for (const spec of custom) registry.register(createCustomAdapter(spec));
  return registry;
}
