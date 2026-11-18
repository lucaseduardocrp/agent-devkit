import { textOnlyFiles, withFiles } from '../adapters/cli-llm/cli-specs.js';
import type { LlmFile, LlmPort } from './agent-ports.js';

/**
 * Text files are written into the prompt, so every provider reads them. Call it on the text that
 * goes inside the sandbox envelope: a file is untrusted input like anything else the user wrote.
 */
export function inlineTextFiles(text: string, files: readonly LlmFile[]): string {
  const readable = files.filter((file) => textOnlyFiles(file.mimeType) === 'text');
  return readable.length ? withFiles(text, readable, textOnlyFiles) : text;
}

/**
 * The documents (PDFs) a provider is handed. One that does not read them gets none, and `note` is
 * what to add to its prompt so the model knows they exist instead of answering as if they did not.
 */
export function documentsFor(
  files: readonly LlmFile[],
  llm: LlmPort,
): { readonly send: readonly LlmFile[]; readonly note: string } {
  const documents = files.filter((file) => textOnlyFiles(file.mimeType) === null);
  if (llm.readsFiles || documents.length === 0) return { send: documents, note: '' };
  return {
    send: [],
    note: `\n\n(${documents.length} attached document(s) could not be read by this provider and are left out.)`,
  };
}
