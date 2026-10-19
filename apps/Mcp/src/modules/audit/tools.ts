import { z } from 'zod';
import type { McpModule } from '../../core/registry.js';
import { defineTool, json } from '../../core/tool.js';
import { page, pageSize } from '../shared.js';

export const auditModule: McpModule = {
  toolset: 'audit',
  tools: [
    defineTool({
      name: 'audit_history',
      title: 'Change history',
      description:
        'Lists the audit history (who changed what and when) for Brain documents, specifications, templates, Test Plans, PBIs, issues or release notes.',
      toolset: 'audit',
      access: 'read',
      routes: ['GET /audit/history'],
      input: {
        entityType: z.enum([
          'document',
          'specification',
          'template',
          'testplan',
          'pbi',
          'issue',
          'release_note',
        ]),
        entityId: z.string().min(1).max(4096).optional().describe('Restrict to one entity.'),
        page,
        pageSize: pageSize(50),
      },
      run: async (input, { api }) =>
        json(await api.request({ method: 'GET', path: '/audit/history', query: input })),
    }),
  ],
};
