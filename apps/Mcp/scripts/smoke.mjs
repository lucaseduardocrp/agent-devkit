#!/usr/bin/env node
// End-to-end smoke test: drives the built stdio server with a real MCP client against a running
// ADK API, exercising the no-API-key (host mode) flows. Usage:
//   ADK_API_URL=http://localhost:3000 node scripts/smoke.mjs
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const apiUrl = process.env.ADK_API_URL ?? 'http://localhost:3000';
const sessionFile = join(mkdtempSync(join(tmpdir(), 'adk-smoke-')), 'session.json');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL('../dist/src/bin/devkit.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')],
  env: { ...process.env, ADK_API_URL: apiUrl, ADK_MCP_SESSION_FILE: sessionFile },
  stderr: 'inherit',
});
const client = new Client({ name: 'adk-smoke', version: '1.0.0' });
await client.connect(transport);

let failures = 0;
async function step(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? '';
  const ok = !result.isError;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `\n  ${text}`}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const { tools } = await client.listTools();
console.log(`tools: ${tools.length}`);
const email = `smoke-${Date.now()}@example.com`;
await step('system_health', { probe: 'ready' });
await step('auth_register', {
  name: 'Smoke',
  email,
  password: randomBytes(18).toString('base64url'),
});
await step('auth_whoami');
const { workspaces } = await step('workspaces_list');
const workspaceId = workspaces[0].workspace.id;
await step('workspaces_select', { workspaceId });

const created = await step('brain_create_document', {
  title: 'Checkout rules',
  content: 'Checkout accepts credit card payments only. Orders above 1000 require approval.',
});
await step('brain_list_documents', { query: 'checkout' });
await step('brain_get_document', { pageId: created.document.pageId });
await step('brain_search', { query: 'checkout credit card approval' });
await step('brain_prepare_answer', { question: 'Which payment methods does checkout accept?' });

const brief = await step('testplans_prepare', {
  prompt: 'The user must pay the checkout with a credit card.',
});
if (!brief.instruction?.includes('JSON')) failures += 1;
const saved = await step('testplans_save', {
  title: 'Checkout payment',
  sourceType: 'brain',
  sourceId: created.document.pageId,
  plans: [
    {
      title: 'Pay with a valid credit card',
      description: 'Main flow',
      steps: [
        { action: 'Open the checkout page', expectedResult: 'The order summary is displayed' },
        { action: 'Pay with a valid credit card', expectedResult: 'The order is confirmed' },
      ],
    },
  ],
});
await step('testplans_get', { testPlanId: saved.savedPlan.id });
await step('testplans_list_suites');
await step('testplans_generate', { prompt: 'Refund an order' });

const agent = await step('agents_create', {
  name: 'QA Lead',
  role: 'QA',
  instructions: 'Cover edge cases.',
});
await step('agents_prepare_run', { agentId: agent.agent.id, prompt: 'Review checkout risks' });

const templates = await step('spec_list_templates');
const template = templates[0];
const spec = await step('spec_save', {
  title: 'Checkout',
  templateId: template?.id,
  sections: (template?.sections ?? []).map((section) => ({
    templateSectionId: section.id,
    title: section.title,
    content: '',
  })),
});
await step('spec_prepare_draft', { specId: spec.id, request: 'Payment rules' });
if (template?.sections?.length) {
  await step('spec_update_sections', {
    specId: spec.id,
    sections: [{ templateSectionId: template.sections[0].id, content: 'Credit card only.' }],
  });
}
await step('spec_export_markdown', { specId: spec.id });
await step('audit_history', { entityType: 'testplan' });
await step('design_list_providers');
await step('auth_logout');

await client.close();
console.log(failures ? `\n${failures} failure(s)` : '\nAll smoke steps passed.');
process.exit(failures ? 1 : 0);
