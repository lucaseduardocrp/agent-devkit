import type { McpPrompt } from './prompt.js';
import { TOOLSETS, type McpTool, type Toolset } from './tool.js';

/** A feature module contributes tools and optional prompts; modules never know about each other. */
export interface McpModule {
  readonly toolset: Toolset;
  readonly tools: readonly McpTool[];
  readonly prompts?: readonly McpPrompt[];
}

export interface RegistryFilter {
  /** Enabled toolsets; empty or undefined enables all of them. */
  readonly toolsets?: readonly Toolset[];
  /** Expose only `read` tools (safe exploration, audits, demos). */
  readonly readOnly?: boolean;
}

export class ToolRegistry {
  public readonly tools: readonly McpTool[];
  public readonly prompts: readonly McpPrompt[];

  public constructor(modules: readonly McpModule[], filter: RegistryFilter = {}) {
    const allTools = modules.flatMap((module) => module.tools);
    const allPrompts = modules.flatMap((module) => module.prompts ?? []);
    assertUnique(
      allTools.map((tool) => tool.name),
      'tool',
    );
    assertUnique(
      allPrompts.map((prompt) => prompt.name),
      'prompt',
    );
    for (const module of modules) {
      const foreign = module.tools.find((tool) => tool.toolset !== module.toolset);
      if (foreign) {
        throw new Error(`Tool ${foreign.name} is declared in the ${module.toolset} module.`);
      }
    }

    const enabled = new Set<Toolset>(filter.toolsets?.length ? filter.toolsets : TOOLSETS);
    this.tools = allTools.filter(
      (tool) => enabled.has(tool.toolset) && (!filter.readOnly || tool.access === 'read'),
    );
    this.prompts = modules
      .filter((module) => enabled.has(module.toolset))
      .flatMap((module) => module.prompts ?? []);
  }

  public find(name: string): McpTool | undefined {
    return this.tools.find((tool) => tool.name === name);
  }
}

function assertUnique(names: readonly string[], kind: string): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) throw new Error(`Duplicate MCP ${kind} name: ${name}`);
    seen.add(name);
  }
}
