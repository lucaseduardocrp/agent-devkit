import { z } from 'zod';
import { segment } from '../../api/http-client.js';
import { definePrompt } from '../../core/prompt.js';
import type { McpModule } from '../../core/registry.js';
import { defineTool, json, text } from '../../core/tool.js';
import { getWorkflowBrief } from '../agents/tools.js';
import { id, page, pageSize, untrusted, UNTRUSTED_CONTENT_RULE } from '../shared.js';

const testPlanId = id('Saved Test Plan id (from testplans_list).');
const suiteId = id('Test suite id (from testplans_list_suites).');
const generationInput = {
  prompt: z
    .string()
    .trim()
    .min(1)
    .describe('Requirement, user story, bug report or spec text to cover.'),
  title: z.string().trim().min(1).optional(),
  criteria: z.string().trim().optional().describe('Acceptance criteria or extra instructions.'),
  agentId: z.string().trim().optional().describe('QA agent whose instructions shape coverage.'),
  sourceType: z
    .enum(['manual', 'brain', 'spec', 'pbi'])
    .optional()
    .describe('Where the requirement came from.'),
  sourceId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Brain pageId, spec id or PBI id of the source.'),
  suiteId: z.string().trim().min(1).optional().describe('Suite to save into (default: "Test").'),
  assignedTo: z.string().trim().optional(),
  areaPath: z.string().trim().optional().describe('Azure DevOps area path used in the CSV export.'),
  platformProvider: z.string().trim().optional().describe('CSV dialect, e.g. azure.'),
};
const serverOnly = {
  llmProvider: z.string().trim().optional().describe('LLM integration provider id.'),
};
const step = z.object({
  order: z.number().int().min(1).optional(),
  action: z.string().trim().min(1).max(2000).describe('One executable action (imperative verb).'),
  expectedResult: z.string().trim().min(1).max(2000).describe('One observable result.'),
  data: z.string().max(2000).optional(),
});
const sectionText = z.string().max(5000).optional();
/** ADK renders these sections into the default description template (bold headings + flow). */
const description = z
  .object({
    useCase: sectionText.describe('What the case validates and why.'),
    preconditions: sectionText.describe('Required state, profile and data.'),
    inputData: sectionText.describe('Data or navigation used.'),
    expectedResult: sectionText.describe('Final observable outcome.'),
    postconditions: sectionText.describe('System state after the case.'),
    flow: z
      .array(
        z.union([
          z.object({ step: z.string().max(200) }),
          z.object({
            decision: z.string().max(200),
            yes: z.string().max(200),
            no: z.string().max(200),
          }),
        ]),
      )
      .max(20)
      .optional()
      .describe(
        'Process diagram: 2-8 short nodes, e.g. {step:"Acessar Painel"} or {decision:"Possui Subtipo?",yes:"Exibir Subtipo",no:"Exibir \\"-\\""}.',
      ),
  })
  .describe('Plain text per section (no HTML/Markdown headings); ADK formats it.');
const plan = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.union([description, z.string().max(20000)]).default(''),
  steps: z.array(step).min(1).max(100),
});

interface GenerationResponse {
  readonly plans: unknown;
  readonly csv?: string;
  readonly savedPlan?: unknown;
}
const withoutCsv = (response: GenerationResponse, includeCsv: boolean) =>
  includeCsv ? response : { plans: response.plans, savedPlan: response.savedPlan };

export const testPlansModule: McpModule = {
  toolset: 'testplans',
  tools: [
    defineTool({
      name: 'testplans_prepare',
      title: 'Prepare Test Plan (host model)',
      description:
        'Returns the official generation instruction (JSON contract, step-quality rules, output language) and the Brain context for a requirement. Write the test cases yourself, then persist them with testplans_save.',
      toolset: 'testplans',
      access: 'read',
      execution: 'host',
      routes: ['POST /TestPlan/brief', 'GET /agents/workflow'],
      input: {
        prompt: generationInput.prompt,
        title: generationInput.title,
        criteria: generationInput.criteria,
        agentId: generationInput.agentId,
      },
      run: async (input, { api }) => {
        const [brief, workflowBrief] = await Promise.all([
          api.request<{
            instruction: string;
            context: string;
            outputLanguage: string;
            knowledgeSources: string[];
          }>({ method: 'POST', path: '/TestPlan/brief', body: input }),
          getWorkflowBrief(api),
        ]);
        return json({
          instruction: brief.instruction,
          outputLanguage: brief.outputLanguage,
          knowledgeSources: brief.knowledgeSources,
          context: untrusted('requirement-and-brain', brief.context),
          ...workflowBrief,
          rules: [UNTRUSTED_CONTENT_RULE, workflowBrief.rule],
          next: 'Generate the JSON array described in `instruction`, show it to the user, then call testplans_save with the plans (use `expectedResult` for each step).',
        });
      },
    }),
    defineTool({
      name: 'testplans_save',
      title: 'Save Test Plan',
      description:
        'Persists test cases you authored (for example after testplans_prepare) as a saved Test Plan and returns it with an Azure DevOps-compatible CSV.',
      toolset: 'testplans',
      access: 'write',
      routes: ['POST /TestPlan'],
      input: {
        title: generationInput.title,
        plans: z.array(plan).min(1).max(100),
        sourceType: generationInput.sourceType,
        sourceId: generationInput.sourceId,
        suiteId: generationInput.suiteId,
        assignedTo: generationInput.assignedTo,
        areaPath: generationInput.areaPath,
        platformProvider: generationInput.platformProvider,
        includeCsv: z.boolean().default(false),
      },
      run: async ({ includeCsv, ...body }, { api }) =>
        json(
          withoutCsv(
            await api.request<GenerationResponse>({ method: 'POST', path: '/TestPlan', body }),
            includeCsv,
          ),
        ),
    }),
    defineTool({
      name: 'testplans_render_csv',
      title: 'Render Test Plan CSV (host model)',
      description:
        'Renders test cases you authored into an Azure DevOps-compatible CSV without saving a Test Plan or calling a workspace LLM. Use testplans_prepare first.',
      toolset: 'testplans',
      access: 'read',
      execution: 'host',
      routes: ['POST /TestPlan/csv'],
      input: {
        plans: z.array(plan).min(1).max(100),
        assignedTo: generationInput.assignedTo,
        areaPath: generationInput.areaPath,
        platformProvider: generationInput.platformProvider,
      },
      run: async (body, { api }) =>
        text(await api.request<string>({ method: 'POST', path: '/TestPlan/csv', body })),
    }),
    defineTool({
      name: 'testplans_generate',
      title: 'Generate Test Plan (server model)',
      description:
        'Generates and saves a Test Plan with the workspace LLM. Without an LLM integration ADK falls back to a basic deterministic plan, so prefer testplans_prepare + testplans_save.',
      toolset: 'testplans',
      access: 'write',
      execution: 'server',
      routes: ['POST /TestPlan/generate'],
      input: { ...generationInput, ...serverOnly, includeCsv: z.boolean().default(false) },
      run: async ({ includeCsv, ...body }, { api }) =>
        json(
          withoutCsv(
            await api.request<GenerationResponse>({
              method: 'POST',
              path: '/TestPlan/generate',
              body,
            }),
            includeCsv,
          ),
        ),
    }),
    defineTool({
      name: 'testplans_generate_csv',
      title: 'Generate Test Plan CSV (server model)',
      description:
        'Generates test cases with the workspace LLM and returns only the CSV (not saved). To use your own model, call testplans_prepare, write the cases, then call testplans_render_csv.',
      toolset: 'testplans',
      access: 'read',
      execution: 'server',
      routes: ['POST /TestPlan/generate/csv'],
      input: { ...generationInput, ...serverOnly },
      run: async (input, { api }) =>
        text(
          await api.request<string>({
            method: 'POST',
            path: '/TestPlan/generate/csv',
            body: input,
          }),
        ),
    }),
    defineTool({
      name: 'testplans_list',
      title: 'List Test Plans',
      description: 'Lists saved Test Plans of the active workspace, newest first.',
      toolset: 'testplans',
      access: 'read',
      routes: ['GET /TestPlan'],
      input: { page, pageSize: pageSize(50) },
      run: async (input, { api }) =>
        json(await api.request({ method: 'GET', path: '/TestPlan', query: input })),
    }),
    defineTool({
      name: 'testplans_get',
      title: 'Get Test Plan',
      description: 'Returns a saved Test Plan with all of its test cases and steps.',
      toolset: 'testplans',
      access: 'read',
      routes: ['GET /TestPlan/:id'],
      input: { testPlanId },
      run: async (input, { api }) =>
        json(await api.request({ method: 'GET', path: `/TestPlan/${segment(input.testPlanId)}` })),
    }),
    defineTool({
      name: 'testplans_update',
      title: 'Update Test Plan',
      description:
        'Renames a saved Test Plan, replaces its test cases, or moves it to another suite.',
      toolset: 'testplans',
      access: 'write',
      routes: ['PUT /TestPlan/:id'],
      input: {
        testPlanId,
        title: z.string().trim().min(1).optional(),
        plans: z
          .array(plan)
          .min(1)
          .max(100)
          .optional()
          .describe('Full replacement of the test cases.'),
        suiteId: z.string().trim().min(1).optional(),
      },
      run: async ({ testPlanId: target, ...body }, { api }) =>
        json(await api.request({ method: 'PUT', path: `/TestPlan/${segment(target)}`, body })),
    }),
    defineTool({
      name: 'testplans_delete',
      title: 'Delete Test Plan',
      description: 'Deletes a saved Test Plan.',
      toolset: 'testplans',
      access: 'destructive',
      routes: ['DELETE /TestPlan/:id'],
      input: { testPlanId },
      run: async (input, { api }) =>
        json(
          await api.request({ method: 'DELETE', path: `/TestPlan/${segment(input.testPlanId)}` }),
        ),
    }),
    defineTool({
      name: 'testplans_list_suites',
      title: 'List test suites',
      description: 'Lists the test suite tree (flat list with parentId).',
      toolset: 'testplans',
      access: 'read',
      routes: ['GET /TestPlan/suites'],
      input: {},
      run: async (_input, { api }) =>
        json(await api.request({ method: 'GET', path: '/TestPlan/suites' })),
    }),
    defineTool({
      name: 'testplans_create_suite',
      title: 'Create test suite',
      description: 'Creates a root suite or a child suite.',
      toolset: 'testplans',
      access: 'write',
      routes: ['POST /TestPlan/suites'],
      input: {
        name: z.string().trim().min(1).max(200),
        parentId: z.string().trim().min(1).optional().describe('Parent suite id.'),
      },
      run: async (input, { api }) =>
        json(await api.request({ method: 'POST', path: '/TestPlan/suites', body: input })),
    }),
    defineTool({
      name: 'testplans_update_suite',
      title: 'Update test suite',
      description: 'Renames a suite or moves it (parentId null moves it to the root).',
      toolset: 'testplans',
      access: 'write',
      routes: ['PUT /TestPlan/suites/:id'],
      input: {
        suiteId,
        name: z.string().trim().min(1).max(200).optional(),
        parentId: z.string().trim().min(1).nullable().optional(),
      },
      run: async ({ suiteId: target, ...body }, { api }) =>
        json(
          await api.request({ method: 'PUT', path: `/TestPlan/suites/${segment(target)}`, body }),
        ),
    }),
    defineTool({
      name: 'testplans_list_publish_providers',
      title: 'List test publishing providers',
      description: 'Lists available test management providers and whether they are configured.',
      toolset: 'testplans',
      access: 'read',
      routes: ['GET /TestPlan/publish/providers'],
      input: {},
      run: async (_input, { api }) =>
        json(await api.request({ method: 'GET', path: '/TestPlan/publish/providers' })),
    }),
    defineTool({
      name: 'testplans_list_remote_plans',
      title: 'List remote Test Plans',
      description: 'Lists every remote Test Plan available through a publishing provider.',
      toolset: 'testplans',
      access: 'read',
      routes: ['GET /TestPlan/publish/plans'],
      input: { providerId: z.string().trim().min(1) },
      run: async (input, { api }) =>
        json(await api.request({ method: 'GET', path: '/TestPlan/publish/plans', query: input })),
    }),
    defineTool({
      name: 'testplans_list_remote_suites',
      title: 'List remote test suites',
      description: 'Lists all suites inside a remote Test Plan, including nested suites.',
      toolset: 'testplans',
      access: 'read',
      routes: ['GET /TestPlan/publish/plans/:planId/suites'],
      input: { providerId: z.string().trim().min(1), remotePlanId: z.string().regex(/^[1-9]\d*$/) },
      run: async ({ remotePlanId, providerId }, { api }) =>
        json(
          await api.request({
            method: 'GET',
            path: `/TestPlan/publish/plans/${segment(remotePlanId)}/suites`,
            query: { providerId },
          }),
        ),
    }),
    defineTool({
      name: 'testplans_push_suite',
      title: 'Push test suite',
      description:
        'Publishes a saved suite and its test cases to the chosen provider. Provide remotePlanId and remoteSuiteId to add all test cases directly to an existing suite; use remoteParentSuiteId to create a child suite under a static suite; omit remote IDs to create a new Test Plan. On Azure DevOps, suiteKind "requirement" creates one Requirement Based Suite per item of workItemIds (PBI, User Story or backlog Bug), each holding every case of the tree; with suiteKind "static" (default), workItemIds of any type (task, bug, PBI...) link each published case to every item with a Tests link. Get the IDs from pbi_list (links with the same providerId).',
      toolset: 'testplans',
      access: 'write',
      routes: ['POST /TestPlan/suites/:id/push'],
      input: {
        suiteId,
        providerId: z
          .string()
          .trim()
          .min(1)
          .describe('Provider ID from testplans_list_publish_providers.'),
        remotePlanId: z
          .string()
          .regex(/^[1-9]\d*$/)
          .optional()
          .describe('Existing remote Test Plan ID. Omit to create a new plan.'),
        remoteParentSuiteId: z
          .string()
          .regex(/^[1-9]\d*$/)
          .optional()
          .describe('Existing remote parent suite ID in remotePlanId.'),
        remoteSuiteId: z
          .string()
          .regex(/^[1-9]\d*$/)
          .optional()
          .describe('Existing destination suite ID in remotePlanId. Adds cases directly to it.'),
        suiteKind: z
          .enum(['static', 'requirement'])
          .optional()
          .describe(
            'Kind of the suite created (Azure DevOps). requirement needs workItemIds and a new plan or remoteParentSuiteId.',
          ),
        workItemIds: z
          .array(z.string().regex(/^[1-9]\d*$/))
          .max(50)
          .optional()
          .describe(
            'Azure DevOps work item IDs the published test cases test (PBI, bug, task...).',
          ),
        workItemId: z
          .string()
          .regex(/^[1-9]\d*$/)
          .optional()
          .describe('A single work item ID; same as workItemIds with one item.'),
      },
      run: async ({ suiteId: target, ...body }, { api }) =>
        json(
          await api.request({
            method: 'POST',
            path: `/TestPlan/suites/${segment(target)}/push`,
            body,
          }),
        ),
    }),
    defineTool({
      name: 'testplans_delete_suite',
      title: 'Delete test suite',
      description: 'Deletes an empty suite (no child suites or plans).',
      toolset: 'testplans',
      access: 'destructive',
      routes: ['DELETE /TestPlan/suites/:id'],
      input: { suiteId },
      run: async (input, { api }) =>
        json(
          await api.request({
            method: 'DELETE',
            path: `/TestPlan/suites/${segment(input.suiteId)}`,
          }),
        ),
    }),
  ],
  prompts: [
    definePrompt({
      name: 'generate_test_plan',
      title: 'Generate a Test Plan',
      description:
        'Create executable test cases grounded on the Brain and save them, without an API key.',
      args: {
        requirement: z.string().describe('Requirement, user story or bug to cover.'),
        criteria: z.string().optional().describe('Acceptance criteria.'),
      },
      render: ({ requirement, criteria }) =>
        `Create an ADK Test Plan.\n1. Call testplans_prepare with the requirement${criteria ? ' and criteria' : ''}.\n2. Follow the returned instruction exactly and write the JSON test cases.\n3. Show a short summary to the user and ask where to save (testplans_list_suites) if unclear.\n4. Save with testplans_save.\n\nRequirement:\n${requirement}${criteria ? `\n\nCriteria:\n${criteria}` : ''}`,
    }),
  ],
};
