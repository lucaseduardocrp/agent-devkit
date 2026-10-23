import { z } from 'zod';

// The parts of the ADK Hub index (lucaseduardocrp/agent-devkit-hub, index.json) that ADK installs
// into a workspace: agents and the subagents of plugins. Skills are installed by `devkit` on the
// user's computer and are not read here. Unknown fields are ignored so newer indexes still load.

const name = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const relativePath = z
  .string()
  .regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/)
  .refine((path) => !path.split('/').includes('..'));
const tier = z.enum(['official', 'verified', 'community']);

const category = z.object({
  id: z.string(),
  icon: z.string(),
  label: z.record(z.string(), z.string()),
});

const agentSchema = z.object({
  name,
  description: z.string(),
  overview: z.string().default(''),
  category: z.string(),
  role: z.enum(['QA', 'DOCUMENTATION', 'REFACTOR', 'CUSTOM']),
  temperature: z.number().min(0).max(2).optional(),
  tags: z.array(z.string()).default([]),
  toolsets: z.array(z.string()).default([]),
  author: z.string(),
  version: z.string(),
  license: z.string(),
  tier,
  path: relativePath,
  files: z
    .array(
      z.object({
        path: relativePath,
        size: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .min(1),
});

const pluginSchema = z.object({
  name,
  title: z.string(),
  description: z.string(),
  repo: z.url({ protocol: /^https$/ }),
  sha,
  subdir: z.union([z.literal(''), relativePath]).default(''),
  version: z.string().optional(),
  maintainer: z.string(),
  tier,
  category: z.string(),
  license: z.string(),
  capabilities: z.object({ agents: z.array(name).default([]) }),
});

const indexSchema = z.object({
  schemaVersion: z.literal(1),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  commit: sha,
  generatedAt: z.string(),
  categories: z.object({ agents: z.array(category).default([]) }),
  agents: z.array(agentSchema).default([]),
  plugins: z.array(pluginSchema).default([]),
  removed: z
    .array(z.object({ name: z.string(), repo: z.string().optional(), reason: z.string() }))
    .default([]),
});

export type HubIndex = z.infer<typeof indexSchema>;
export type HubAgentEntry = z.infer<typeof agentSchema>;
export type HubPluginEntry = z.infer<typeof pluginSchema>;

/** Checks the shape of a downloaded index; returns null when this ADK cannot read it. */
export function parseHubIndex(raw: unknown): HubIndex | null {
  const parsed = indexSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The instructions file of a hub agent: agents/<name>/AGENT.md. */
export function agentFileOf(agent: HubAgentEntry) {
  return agent.files.find((file) => file.path === 'AGENT.md') ?? agent.files[0]!;
}
