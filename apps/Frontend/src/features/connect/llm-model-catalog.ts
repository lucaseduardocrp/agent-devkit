export interface LlmModelOption {
  readonly id: string;
  readonly label: string;
}

export interface LlmProviderModelCatalog {
  readonly label: string;
  readonly defaultModel: string;
  readonly models: readonly LlmModelOption[];
}

// Update model choices here. Custom IDs remain supported for account-specific
// models and providers such as Ollama, whose installed models vary by instance.
export const llmModelCatalog = {
  gemini: {
    label: 'Modelo Gemini',
    defaultModel: 'gemini-3.8-flash',
    models: [
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
      { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
      { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)' },
    ],
  },
  openai: {
    label: 'Modelo OpenAI',
    defaultModel: 'gpt-5.1',
    models: [
      { id: 'gpt-5.1', label: 'GPT-5.1' },
      { id: 'gpt-5', label: 'GPT-5' },
      { id: 'gpt-5-mini', label: 'GPT-5 mini' },
      { id: 'gpt-5-nano', label: 'GPT-5 nano' },
      { id: 'gpt-4.1', label: 'GPT-4.1' },
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
      { id: 'gpt-4.1-nano', label: 'GPT-4.1 nano' },
    ],
  },
  claude: {
    label: 'Modelo Claude',
    defaultModel: 'claude-sonnet-4-6',
    models: [
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
      { id: 'claude-opus-5', label: 'Claude Opus 5' },
      { id: 'claude-fable-5', label: 'Claude Fable 5' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    ],
  },
  groq: {
    label: 'Modelo Groq',
    defaultModel: 'llama-3.3-70b-versatile',
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile' },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant' },
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' },
      { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B' },
      { id: 'groq/compound', label: 'Groq Compound' },
      { id: 'groq/compound-mini', label: 'Groq Compound Mini' },
    ],
  },
  ollama: {
    label: 'Modelo Ollama',
    defaultModel: 'llama3.2',
    models: [
      { id: 'llama3.2', label: 'Llama 3.2' },
      { id: 'llama3.1', label: 'Llama 3.1' },
      { id: 'mistral', label: 'Mistral' },
      { id: 'qwen3', label: 'Qwen 3' },
      { id: 'gemma3', label: 'Gemma 3' },
      { id: 'deepseek-r1', label: 'DeepSeek R1' },
    ],
  },
} as const satisfies Record<string, LlmProviderModelCatalog>;

export type LlmProviderId = keyof typeof llmModelCatalog;

export function getLlmModelCatalog(providerId: string): LlmProviderModelCatalog | undefined {
  return llmModelCatalog[providerId as LlmProviderId];
}
