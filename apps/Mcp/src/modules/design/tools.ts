import { z } from 'zod';
import { segment, type AdkApi } from '../../api/http-client.js';
import { definePrompt } from '../../core/prompt.js';
import type { McpModule } from '../../core/registry.js';
import { defineTool, json } from '../../core/tool.js';
import { untrusted, UNTRUSTED_CONTENT_RULE } from '../shared.js';

interface DesignFile {
  readonly name: string;
  readonly language: string;
  readonly content: string;
}
interface DesignProject {
  readonly id: string;
  readonly title: string;
  readonly files: readonly DesignFile[];
  readonly messages: readonly { role: string; content: string }[];
}
interface DesignSystem {
  readonly id: string;
  readonly name: string;
  readonly content: string;
}

const provider = z
  .enum(['github', 'azure'])
  .describe('Repository that stores the prototypes (see design_list_providers).');
const projectId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,159}$/)
  .describe('Prototype id (from design_list_projects).');
const systemId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,159}$/)
  .describe('Design System id.');
const agentId = z.string().uuid().describe('Agent id.');
const images = z
  .array(
    z.object({
      mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
      data: z.string().min(1).describe('Base64 image data (max 5 MB).'),
    }),
  )
  .max(4)
  .optional()
  .describe('Optional reference images.');
const file = z.object({
  name: z.string().trim().min(1).max(160).describe('Relative path, e.g. index.html.'),
  language: z.string().trim().min(1).max(40).describe('html, css, javascript, jsx…'),
  content: z.string().max(500000),
});
const files = z.array(file).min(1).max(30);

const PROTOTYPE_RULES = [
  'Produce an executable, responsive and accessible prototype that works without external dependencies.',
  'Always include index.html, styles.css and script.js; .jsx components are allowed when useful.',
  'File names are relative paths; never use "..", absolute paths or the .design folder.',
  'When a Design System is given, use its tokens, typography, spacing and components.',
  UNTRUSTED_CONTENT_RULE,
];

async function getProject(api: AdkApi, repository: string, id: string): Promise<DesignProject> {
  return api.request<DesignProject>({
    method: 'GET',
    path: `/design/projects/${segment(id)}`,
    query: { provider: repository },
  });
}

export const designModule: McpModule = {
  toolset: 'design',
  tools: [
    defineTool({
      name: 'design_list_providers',
      title: 'Design repositories',
      description: 'Lists the repositories (github / azure) configured to store Design prototypes.',
      toolset: 'design',
      access: 'read',
      routes: ['GET /design/providers'],
      input: {},
      run: async (_input, { api }) =>
        json(await api.request({ method: 'GET', path: '/design/providers' })),
    }),
    defineTool({
      name: 'design_list_projects',
      title: 'List prototypes',
      description: 'Lists Design prototypes stored in a repository (files omitted).',
      toolset: 'design',
      access: 'read',
      routes: ['GET /design/projects'],
      input: { provider },
      run: async (input, { api }) => {
        const result = await api.request<{ projects: DesignProject[] }>({
          method: 'GET',
          path: '/design/projects',
          query: input,
        });
        return json({
          projects: result.projects.map(({ files: projectFiles, messages, ...project }) => ({
            ...project,
            files: projectFiles.map((item) => item.name),
            messages: messages.length,
          })),
        });
      },
    }),
    defineTool({
      name: 'design_get_project',
      title: 'Get prototype',
      description: 'Returns a prototype with its files and conversation.',
      toolset: 'design',
      access: 'read',
      routes: ['GET /design/projects/:id'],
      input: {
        provider,
        projectId,
        includeContent: z.boolean().default(true).describe('Include file contents.'),
      },
      run: async (input, { api }) => {
        const project = await getProject(api, input.provider, input.projectId);
        return json(
          input.includeContent
            ? project
            : {
                ...project,
                files: project.files.map((item) => ({
                  name: item.name,
                  language: item.language,
                  size: item.content.length,
                })),
              },
        );
      },
    }),
    defineTool({
      name: 'design_prepare',
      title: 'Prepare prototype (host model)',
      description:
        'Returns the prototype rules, the chosen Design System and (for an existing prototype) its current files, so you write the prototype yourself. Save with design_save_new_project or design_update_files.',
      toolset: 'design',
      access: 'read',
      execution: 'host',
      routes: ['GET /design/systems', 'GET /design/projects/:id'],
      input: {
        provider,
        request: z.string().trim().min(1).max(20000).describe('What to build or change.'),
        projectId: projectId.optional().describe('Existing prototype to change.'),
        designSystemId: systemId.optional(),
      },
      run: async (input, { api }) => {
        const [systems, project] = await Promise.all([
          input.designSystemId
            ? api.request<{ systems: DesignSystem[] }>({
                method: 'GET',
                path: '/design/systems',
                query: { provider: input.provider },
              })
            : Promise.resolve({ systems: [] as DesignSystem[] }),
          input.projectId
            ? getProject(api, input.provider, input.projectId)
            : Promise.resolve(undefined),
        ]);
        const system = systems.systems.find((item) => item.id === input.designSystemId);
        if (input.designSystemId && !system) {
          throw new Error(
            `Design System ${input.designSystemId} was not found in ${input.provider}.`,
          );
        }
        return json({
          mode: project ? 'change-existing' : 'create-new',
          request: input.request,
          rules: PROTOTYPE_RULES,
          designSystem: system ? untrusted(`design-system:${system.id}`, system.content) : null,
          currentFiles: project?.files ?? [],
          recentConversation: project?.messages.slice(-10) ?? [],
          save: project
            ? `design_update_files { provider: "${input.provider}", projectId: "${project.id}", files }`
            : `design_save_new_project { provider: "${input.provider}", title, prompt, files, summary }`,
        });
      },
    }),
    defineTool({
      name: 'design_save_new_project',
      title: 'Save new prototype',
      description:
        'Creates a prototype in the repository from files you authored (no API key needed).',
      toolset: 'design',
      access: 'write',
      routes: ['POST /design/projects'],
      input: {
        provider,
        title: z.string().trim().min(1).max(120),
        prompt: z
          .string()
          .trim()
          .min(1)
          .max(20000)
          .describe('The original request (kept as history).'),
        files,
        summary: z
          .string()
          .trim()
          .min(1)
          .max(2000)
          .optional()
          .describe('Short summary of the prototype.'),
        designSystemId: systemId.optional(),
      },
      run: async (input, { api }) =>
        json(await api.request({ method: 'POST', path: '/design/projects', body: input })),
    }),
    defineTool({
      name: 'design_create_project',
      title: 'Create prototype (server model)',
      description: 'Generates a new prototype with an agent and stores it in the repository.',
      toolset: 'design',
      access: 'write',
      execution: 'server',
      routes: ['POST /design/projects'],
      input: {
        provider,
        title: z.string().trim().min(1).max(120),
        agentId,
        prompt: z.string().trim().min(1).max(20000),
        designSystemId: systemId.optional(),
        images,
      },
      run: async (input, { api }) =>
        json(await api.request({ method: 'POST', path: '/design/projects', body: input })),
    }),
    defineTool({
      name: 'design_chat',
      title: 'Iterate prototype (server model)',
      description:
        'Asks a workspace LLM agent to change an existing prototype. To use your own model, call design_prepare and save the complete file set with design_update_files.',
      toolset: 'design',
      access: 'write',
      execution: 'server',
      routes: ['POST /design/projects/:id/messages'],
      input: {
        provider,
        projectId,
        content: z.string().trim().min(1).max(20000),
        agentId: agentId.optional(),
        images,
      },
      run: async ({ provider: repository, projectId: target, ...body }, { api }) =>
        json(
          await api.request({
            method: 'POST',
            path: `/design/projects/${segment(target)}/messages`,
            query: { provider: repository },
            body,
          }),
        ),
    }),
    defineTool({
      name: 'design_update_files',
      title: 'Update prototype files',
      description: 'Replaces the files of a prototype (send the complete file set).',
      toolset: 'design',
      access: 'write',
      routes: ['PUT /design/projects/:id/files'],
      input: { provider, projectId, files },
      run: async ({ provider: repository, projectId: target, ...body }, { api }) =>
        json(
          await api.request({
            method: 'PUT',
            path: `/design/projects/${segment(target)}/files`,
            query: { provider: repository },
            body,
          }),
        ),
    }),
    defineTool({
      name: 'design_delete_project',
      title: 'Delete prototype',
      description: 'Deletes a prototype from the repository.',
      toolset: 'design',
      access: 'destructive',
      routes: ['DELETE /design/projects/:id'],
      input: { provider, projectId },
      run: async (input, { api }) =>
        json(
          await api.request({
            method: 'DELETE',
            path: `/design/projects/${segment(input.projectId)}`,
            query: { provider: input.provider },
          }),
        ),
    }),
    defineTool({
      name: 'design_list_systems',
      title: 'List Design Systems',
      description:
        'Lists Design Systems (self-contained HTML style guides) stored in a repository.',
      toolset: 'design',
      access: 'read',
      routes: ['GET /design/systems'],
      input: { provider, includeContent: z.boolean().default(false) },
      run: async (input, { api }) => {
        const result = await api.request<{ systems: DesignSystem[] }>({
          method: 'GET',
          path: '/design/systems',
          query: { provider: input.provider },
        });
        return json(
          input.includeContent
            ? result
            : {
                systems: result.systems.map(({ content, ...system }) => ({
                  ...system,
                  size: content.length,
                })),
              },
        );
      },
    }),
    defineTool({
      name: 'design_generate_system',
      title: 'Generate Design System (server model)',
      description:
        'Generates Design System HTML with a workspace LLM agent. To use your own model, author the HTML and save it with design_save_system.',
      toolset: 'design',
      access: 'read',
      execution: 'server',
      routes: ['POST /design/systems/generate'],
      input: { agentId, prompt: z.string().trim().min(1).max(20000), images },
      run: async (input, { api }) =>
        json(await api.request({ method: 'POST', path: '/design/systems/generate', body: input })),
    }),
    defineTool({
      name: 'design_save_system',
      title: 'Save Design System',
      description:
        'Creates or updates a Design System: one self-contained HTML file (CSS inside <style>) with color, typography and spacing tokens plus component examples. You can author it yourself (no API key needed).',
      toolset: 'design',
      access: 'write',
      routes: ['PUT /design/systems'],
      input: {
        provider,
        systemId: systemId.optional().describe('Existing id to update.'),
        name: z.string().trim().min(1).max(120),
        content: z.string().trim().min(1).max(100_000).describe('HTML document.'),
      },
      run: async ({ provider: repository, systemId: existing, ...body }, { api }) =>
        json(
          await api.request({
            method: 'PUT',
            path: '/design/systems',
            query: { provider: repository },
            body: { ...body, id: existing },
          }),
        ),
    }),
    defineTool({
      name: 'design_delete_system',
      title: 'Delete Design System',
      description: 'Deletes a Design System from the repository.',
      toolset: 'design',
      access: 'destructive',
      routes: ['DELETE /design/systems/:id'],
      input: { provider, systemId },
      run: async (input, { api }) =>
        json(
          await api.request({
            method: 'DELETE',
            path: `/design/systems/${segment(input.systemId)}`,
            query: { provider: input.provider },
          }),
        ),
    }),
  ],
  prompts: [
    definePrompt({
      name: 'create_prototype',
      title: 'Create a prototype',
      description: 'Build an HTML/CSS/JS prototype in the Design repository, without an API key.',
      args: {
        request: z.string().describe('What to build.'),
        provider: z.string().optional().describe('github or azure.'),
      },
      render: ({ request, provider: repository }) =>
        `Create an ADK Design prototype.\n1. ${repository ? `Use the "${repository}" repository.` : 'Call design_list_providers and pick the repository.'} Optionally pick a Design System with design_list_systems.\n2. Call design_prepare and follow its rules.\n3. Write the files and save them with design_save_new_project.\n\nRequest: ${request}`,
    }),
  ],
};
