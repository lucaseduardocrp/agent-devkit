import type { SearchableSelectOption } from '../../components/ui/searchable-select.js';
import { getLlmModelCatalog, llmModelCatalog } from '../connect/llm-model-catalog.js';

/** Providers a model can be recommended from. MCP is how a run is driven, not a provider. */
const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  claude: 'Anthropic (Claude)',
  openai: 'OpenAI',
  gemini: 'Google (Gemini)',
  groq: 'Groq',
  ollama: 'Ollama',
};

/** Names the engine or users may have stored for a provider the catalog knows by another id. */
const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  anthropic: 'claude',
  google: 'gemini',
};

const catalogId = (provider: string): string => {
  const key = provider.trim().toLowerCase();
  return PROVIDER_ALIASES[key] ?? key;
};

/**
 * Providers a human can pick without typing; the stored value is the id the workspace uses.
 * A stored alias (e.g. "anthropic") stays selectable under the name of its provider.
 */
export function providerChoices(current = ''): SearchableSelectOption[] {
  const choices = Object.keys(llmModelCatalog).map((id) => ({
    value: id,
    label: PROVIDER_LABELS[id] ?? id,
  }));
  const alias = catalogId(current);
  if (current && alias !== current && PROVIDER_LABELS[alias])
    choices.push({ value: current, label: `${PROVIDER_LABELS[alias]} · ${current}` });
  return choices;
}

/** Models of the catalog for a provider; empty for providers without a list (MCP, custom). */
export function modelChoices(provider: string): SearchableSelectOption[] {
  return (getLlmModelCatalog(catalogId(provider))?.models ?? []).map((model) => ({
    value: model.id,
    label: `${model.label} (${model.id})`,
  }));
}

/** Model to preselect after the provider changes, so the pair is never inconsistent. */
export function defaultModelFor(provider: string): string {
  return getLlmModelCatalog(catalogId(provider))?.defaultModel ?? '';
}
