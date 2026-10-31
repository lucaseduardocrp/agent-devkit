import type { Scripts } from '../engine/types.js';

/**
 * Scripts in ADK call one API object, `adk`. Collections from other tools call their own: `bru` in
 * Bruno, `pm` and the legacy `postman` in Postman, `insomnia` in Insomnia. The runtime's `adk`
 * answers all of their calls, so imports only rename the object, and exports rename it back to
 * the one the target tool knows.
 */
export type ForeignScriptApi = 'bru' | 'pm' | 'insomnia';

// The object as a variable followed by a member: not `obj.pm.x`, `pmValue` or `'pm'`.
const FOREIGN = /(?<![\w$.])(?:bru|pm|postman|insomnia)(?=\s*\.)/g;
const ADK = /(?<![\w$.])adk(?=\s*\.)/g;

export function toAdkScript(script: string): string {
  return script.replace(FOREIGN, 'adk');
}

export function fromAdkScript(script: string, api: ForeignScriptApi): string {
  return script.replace(ADK, api);
}

function mapScripts(scripts: Scripts, rename: (script: string) => string): Scripts {
  return Object.fromEntries(
    Object.entries(scripts).map(([phase, script]) => [
      phase,
      typeof script === 'string' ? rename(script) : script,
    ]),
  );
}

/** The scripts of an imported item, calling `adk`. */
export function toAdkScripts<T extends Scripts | undefined>(scripts: T): T {
  return (scripts ? mapScripts(scripts, toAdkScript) : scripts) as T;
}

/** The scripts of an exported item, calling the target tool's object. */
export function fromAdkScripts<T extends Scripts | undefined>(
  scripts: T,
  api: ForeignScriptApi,
): T {
  return (scripts ? mapScripts(scripts, (script) => fromAdkScript(script, api)) : scripts) as T;
}
