import type { BriefPrompt } from './agent-brief-types.js';

/** Rough size of a text for the model (about four characters per token). */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** The three parts in the order the agent receives them. */
export const fullPrompt = (prompt: BriefPrompt): string =>
  `${prompt.system}\n\n${prompt.task}\n\n${prompt.outputFormat}`;
