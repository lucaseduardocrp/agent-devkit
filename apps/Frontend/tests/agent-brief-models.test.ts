import { describe, expect, it } from 'vitest';
import {
  defaultModelFor,
  modelChoices,
  providerChoices,
} from '../src/features/issues/agent-brief-models.js';

describe('agent brief provider and model choices', () => {
  it('lists the catalog providers, not MCP', () => {
    const values = providerChoices().map((option) => option.value);
    expect(values).toEqual(['gemini', 'openai', 'claude', 'groq', 'ollama']);
  });

  it('keeps a stored alias selectable under its provider name', () => {
    expect(providerChoices('anthropic').at(-1)).toEqual({
      value: 'anthropic',
      label: 'Anthropic (Claude) · anthropic',
    });
    expect(providerChoices('claude')).toHaveLength(5);
    expect(providerChoices('something-else')).toHaveLength(5);
  });

  it('offers the models of a provider, including its aliases and the 5.5 Claude family', () => {
    const ids = modelChoices('anthropic').map((option) => option.value);
    expect(ids).toEqual(expect.arrayContaining(['claude-sonnet-5-5', 'claude-opus-5-5']));
    expect(modelChoices('claude')).toEqual(modelChoices('Anthropic'));
    expect(modelChoices('mcp')).toEqual([]);
    expect(modelChoices('custom')).toEqual([]);
  });

  it('picks a default model per provider, empty when there is no list', () => {
    expect(defaultModelFor('openai')).toBe('gpt-5.1');
    expect(defaultModelFor('google')).toBe('gemini-3.8-flash');
    expect(defaultModelFor('mcp')).toBe('');
  });
});
