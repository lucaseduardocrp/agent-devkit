import { z } from 'zod';
import { segment } from '../../api/http-client.js';
import type { McpModule } from '../../core/registry.js';
import { defineTool, json } from '../../core/tool.js';
import { id } from '../shared.js';

const boardProvider = z.enum(['azure_devops', 'trello', 'jira', 'github_projects']);
const entityType = z
  .enum(['pbi', 'test_case'])
  .describe(
    'pbi: board items pushed to a board; test_case: test cases published to a test platform.',
  );
const templateId = z
  .string()
  .uuid()
  .describe('Field mapping template id (see field_mappings_list).');
const fieldValue = z.union([
  z.string().max(30000),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(500)).max(100),
  z.null(),
]);
const templateInput = {
  name: z.string().trim().min(1).max(200).describe('Template name, e.g. "Bugs → Azure DevOps".'),
  entityType,
  providerId: boardProvider.describe('Platform whose fields the template fills.'),
  scope: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe('Provider scope such as an Azure DevOps project; empty applies to all.'),
  itemType: z
    .string()
    .trim()
    .max(100)
    .optional()
    .describe('Work item type such as "Bug" or "Test Case"; empty applies to all.'),
  rules: z
    .array(
      z.object({
        targetFieldId: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe('Provider field to fill (see pbi_field_catalog or testplans_publish_fields).'),
        source: z
          .discriminatedUnion('kind', [
            z.object({ kind: z.literal('core'), key: z.string().trim().min(1).max(200) }),
            z.object({
              kind: z.literal('custom'),
              providerId: boardProvider,
              key: z.string().trim().min(1).max(200),
            }),
            z.object({ kind: z.literal('constant'), value: fieldValue }),
          ])
          .describe(
            'Where the value comes from: an ADK field (core), a custom field captured from a provider, or a constant.',
          ),
        choices: z
          .record(z.string().max(500), z.string().max(500))
          .optional()
          .describe('Maps source values to the provider allowed values.'),
        required: z.boolean().optional(),
      }),
    )
    .max(200),
};

/** Reusable templates that fill provider fields when items or test cases are published. */
export const fieldMappingsModule: McpModule = {
  toolset: 'integrations',
  tools: [
    defineTool({
      name: 'field_mappings_list',
      title: 'List field mapping templates',
      description:
        'Lists the workspace templates that map ADK data to provider fields for board items (pbi) or test cases (test_case), optionally for one provider.',
      toolset: 'integrations',
      access: 'read',
      routes: ['GET /field-mappings'],
      input: { entityType, providerId: boardProvider.optional() },
      run: async (query, { api }) =>
        json(await api.request({ method: 'GET', path: '/field-mappings', query })),
    }),
    defineTool({
      name: 'field_mappings_create',
      title: 'Create field mapping template',
      description:
        'Creates a template that fills provider fields when board items are pushed or test cases are published. Check the provider fields first with pbi_field_catalog or testplans_publish_fields.',
      toolset: 'integrations',
      access: 'write',
      routes: ['POST /field-mappings'],
      input: templateInput,
      run: async (body, { api }) =>
        json(await api.request({ method: 'POST', path: '/field-mappings', body })),
    }),
    defineTool({
      name: 'field_mappings_update',
      title: 'Update field mapping template',
      description: 'Replaces the name, target and rules of a field mapping template.',
      toolset: 'integrations',
      access: 'write',
      routes: ['PUT /field-mappings/:id'],
      input: { templateId, ...templateInput },
      run: async ({ templateId: value, ...body }, { api }) =>
        json(await api.request({ method: 'PUT', path: `/field-mappings/${segment(value)}`, body })),
    }),
    defineTool({
      name: 'field_mappings_delete',
      title: 'Delete field mapping template',
      description: 'Deletes a field mapping template. Confirm with the user first.',
      toolset: 'integrations',
      access: 'destructive',
      routes: ['DELETE /field-mappings/:id'],
      input: { templateId },
      run: async ({ templateId: value }, { api }) => {
        await api.request({ method: 'DELETE', path: `/field-mappings/${segment(value)}` });
        return json({ deleted: true, templateId: value });
      },
    }),
  ],
};

export const pbiFieldsModule: McpModule = {
  toolset: 'pbi',
  tools: [
    defineTool({
      name: 'pbi_field_catalog',
      title: 'List board provider fields',
      description:
        'Lists the fields a board provider accepts (ids, types, allowed values), to build field mapping templates.',
      toolset: 'pbi',
      access: 'read',
      routes: ['GET /pbi/field-catalog'],
      input: {
        providerId: boardProvider,
        scope: z
          .string()
          .max(200)
          .optional()
          .describe('Provider scope, e.g. an Azure DevOps project.'),
        itemType: z.string().max(100).optional().describe('Work item type, e.g. "Bug".'),
      },
      run: async (query, { api }) =>
        json(await api.request({ method: 'GET', path: '/pbi/field-catalog', query })),
    }),
    defineTool({
      name: 'pbi_field_preview',
      title: 'Preview mapped fields of a board item',
      description:
        'Shows the provider field values a template would produce for one board item, without pushing it.',
      toolset: 'pbi',
      access: 'read',
      routes: ['POST /pbi/items/:id/field-preview'],
      input: {
        itemId: id('Internal PBI/card UUID.'),
        providerId: boardProvider,
        templateId,
        scope: z.string().max(200).optional(),
        itemType: z.string().max(100).optional(),
      },
      run: async ({ itemId, ...body }, { api }) =>
        json(
          await api.request({
            method: 'POST',
            path: `/pbi/items/${segment(itemId)}/field-preview`,
            body,
          }),
        ),
    }),
  ],
};

const suiteId = id('Local test suite id (see testplans_list_suites).');
const testProvider = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .describe('Test management provider id, e.g. azure_devops (see e2e_test_management_providers).');

export const testPlanFieldsModule: McpModule = {
  toolset: 'testplans',
  tools: [
    defineTool({
      name: 'testplans_publish_fields',
      title: 'List test case fields of a provider',
      description:
        'Lists the Test Case fields a test management provider accepts, to build test_case field mapping templates.',
      toolset: 'testplans',
      access: 'read',
      routes: ['GET /TestPlan/publish/fields'],
      input: { providerId: testProvider },
      run: async (query, { api }) =>
        json(await api.request({ method: 'GET', path: '/TestPlan/publish/fields', query })),
    }),
    defineTool({
      name: 'testplans_field_sources',
      title: 'List custom fields of a suite',
      description:
        'Lists the provider custom fields found on the test cases of a local suite (and its child suites), usable as "custom" sources in templates.',
      toolset: 'testplans',
      access: 'read',
      routes: ['GET /TestPlan/suites/:id/field-sources'],
      input: { suiteId },
      run: async ({ suiteId: value }, { api }) =>
        json(
          await api.request({
            method: 'GET',
            path: `/TestPlan/suites/${segment(value)}/field-sources`,
          }),
        ),
    }),
    defineTool({
      name: 'testplans_field_preview',
      title: 'Preview mapped fields of a suite',
      description:
        'Shows the provider field values a test_case template would produce for the test cases of a local suite (first 20), without publishing.',
      toolset: 'testplans',
      access: 'read',
      routes: ['POST /TestPlan/suites/:id/field-preview'],
      input: { suiteId, providerId: testProvider, templateId },
      run: async ({ suiteId: value, ...body }, { api }) =>
        json(
          await api.request({
            method: 'POST',
            path: `/TestPlan/suites/${segment(value)}/field-preview`,
            body,
          }),
        ),
    }),
    defineTool({
      name: 'testplans_import_cases',
      title: 'Import Test Plans, suites and cases',
      description:
        'Imports test cases that already exist on a test management platform (Azure Test Plans, TestRail, Xray) into ADK, so they need not be written again. Without suiteId the whole plan is imported: its suite hierarchy becomes local suites (under a suite named after the plan, or under localSuiteId) and each remote suite one Test Plan. Each case keeps its steps, remote id, link and every provider field (standard and custom) in metadata.customFields / metadata.customFieldLabels. Importing again refreshes the same Test Plans in place, keeping local case ids. Browse the platform first with e2e_test_management_providers, e2e_list_remote_plans, e2e_list_remote_suites and e2e_list_remote_cases. The imported cases can then be automated with e2e_create savedCases.',
      toolset: 'testplans',
      access: 'write',
      routes: ['POST /TestPlan/import'],
      input: {
        providerId: testProvider,
        planId: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe('Remote plan id (Azure Test Plan, TestRail project or Xray Test Plan key).'),
        suiteId: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe('Only this remote suite; the whole plan when omitted.'),
        includeChildSuites: z
          .boolean()
          .optional()
          .describe('With suiteId, also import the suites nested under it (Azure).'),
        localSuiteId: z
          .string()
          .uuid()
          .optional()
          .describe(
            'Local ADK suite that receives the import; a suite named after the remote plan (or suite) when omitted.',
          ),
        caseIds: z
          .array(z.string().trim().min(1))
          .min(1)
          .max(2_000)
          .optional()
          .describe('Only these remote case ids; the other cases of the Test Plan are kept.'),
      },
      run: async (body, { api }) =>
        json(await api.request({ method: 'POST', path: '/TestPlan/import', body })),
    }),
  ],
};
