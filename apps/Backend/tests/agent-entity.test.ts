import { describe, expect, it } from 'vitest';
import { CustomAgent, slugify } from '../src/modules/agents/domain/agent-entity.js';
import { ApplicationError } from '../src/shared/errors.js';

describe('CustomAgent Entity & slugify', () => {
  describe('slugify', () => {
    it('generates clean slugs with diacritics stripped', () => {
      expect(slugify('QA Lead — Documentação & Testes')).toBe('qa-lead-documentacao-testes');
      expect(slugify('  Recálculo de Eventos 2026!  ')).toBe('recalculo-de-eventos-2026');
      expect(slugify('!!!')).toBe('agent');
    });
  });

  describe('CustomAgent', () => {
    it('creates an agent with valid properties', () => {
      const agent = new CustomAgent({
        id: 'ag-1',
        workspaceId: 'ws-1',
        name: 'QA Analyst',
        slug: 'qa-analyst',
        description: 'Especialista em QA',
        role: 'QA',
        instructions: '# Diretrizes de QA\nEscreva testes detalhados.',
        temperature: 0.3,
        isDefault: true,
      });

      expect(agent.id).toBe('ag-1');
      expect(agent.workspaceId).toBe('ws-1');
      expect(agent.name).toBe('QA Analyst');
      expect(agent.slug).toBe('qa-analyst');
      expect(agent.role).toBe('QA');
      expect(agent.temperature).toBe(0.3);
      expect(agent.isDefault).toBe(true);

      const json = agent.toJSON();
      expect(json.id).toBe('ag-1');
      expect(json.createdAt).toBeDefined();
      expect(json.updatedAt).toBeDefined();
    });

    it('uses default values when optional fields are omitted', () => {
      const agent = new CustomAgent({
        id: 'ag-2',
        workspaceId: 'ws-1',
        name: 'Doc Writer',
        slug: '',
        description: '',
        instructions: '# Docs',
        role: undefined as any,
        model: '  gemini-2.5-flash  ',
        temperature: null,
      });

      expect(agent.slug).toBe('doc-writer');
      expect(agent.role).toBe('CUSTOM');
      expect(agent.model).toBe('gemini-2.5-flash');
      expect(agent.temperature).toBe(0.2);
      expect(agent.isDefault).toBe(false);
      expect(agent.toJSON().model).toBe('gemini-2.5-flash');
    });

    it('throws when required fields are missing or invalid', () => {
      expect(
        () =>
          new CustomAgent({
            id: '',
            workspaceId: 'ws-1',
            name: 'Agent',
            slug: 'agent',
            description: '',
            role: 'CUSTOM',
            instructions: 'rules',
          }),
      ).toThrow(ApplicationError);

      expect(
        () =>
          new CustomAgent({
            id: 'id',
            workspaceId: '',
            name: 'Agent',
            slug: 'agent',
            description: '',
            role: 'CUSTOM',
            instructions: 'rules',
          }),
      ).toThrow(ApplicationError);

      expect(
        () =>
          new CustomAgent({
            id: 'id',
            workspaceId: 'ws-1',
            name: '',
            slug: 'agent',
            description: '',
            role: 'CUSTOM',
            instructions: 'rules',
          }),
      ).toThrow(ApplicationError);

      expect(
        () =>
          new CustomAgent({
            id: 'id',
            workspaceId: 'ws-1',
            name: 'Agent',
            slug: 'agent',
            description: '',
            role: 'CUSTOM',
            instructions: '',
          }),
      ).toThrow(ApplicationError);

      expect(
        () =>
          new CustomAgent({
            id: 'id',
            workspaceId: 'ws-1',
            name: 'Agent',
            slug: 'agent',
            description: '',
            role: 'CUSTOM',
            instructions: 'rules',
            temperature: 2.5,
          }),
      ).toThrow(ApplicationError);
    });
  });
});
