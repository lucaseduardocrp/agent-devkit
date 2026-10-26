/**
 * Static checks for AI-authored Playwright scripts before they run on the backend host.
 * The child process already gets a stripped environment, a throwaway directory and a
 * timeout; this guard keeps generated code inside the browser-automation surface
 * (no Node modules, process access, file paths or custom browser launches).
 * It is a deny-list and therefore defense in depth, not a sandbox.
 */
const ALLOWED_ENV = /\bprocess\.env\.(E2E_USERNAME|E2E_PASSWORD|E2E_BASE_URL)\b/g;
const STRINGS_AND_COMMENTS = /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
const KEYWORDS_BEFORE_ARRAY = new Set(['of', 'in', 'return', 'case', 'typeof', 'await', 'yield']);

const FORBIDDEN: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /\brequire\s*\(/, reason: 'require() is not allowed' },
  { pattern: /\bimport\s*\(/, reason: 'dynamic import() is not allowed' },
  { pattern: /\bprocess\b/, reason: 'process access is not allowed' },
  { pattern: /\b(globalThis|global|self)\b/, reason: 'global object access is not allowed' },
  { pattern: /\b(eval|Function)\s*\(|\bnew\s+Function\b/, reason: 'dynamic code is not allowed' },
  { pattern: /\bconstructor\b|__proto__|\bprototype\b/, reason: 'prototype access is not allowed' },
  {
    pattern: /\b(Deno|Bun|module|exports|__dirname|__filename)\b|\bimport\.meta\b/,
    reason: 'runtime globals are not allowed',
  },
  {
    pattern: /\b(chromium|firefox|webkit|_electron|_android|browserType)\b/,
    reason: 'launching browsers directly is not allowed',
  },
  {
    pattern: /\b(launch|launchServer|launchPersistentContext|connectOverCDP)\s*\(/,
    reason: 'launching browsers directly is not allowed',
  },
  {
    pattern: /\b(executablePath|launchOptions|connectOptions)\b/,
    reason: 'browser launch options are not allowed',
  },
  { pattern: /\bpath\s*:/, reason: 'file paths are not allowed' },
  {
    pattern: /\b(setInputFiles|storageState|routeFromHAR|recordHar|recordVideo)\b/,
    reason: 'file access is not allowed',
  },
  {
    pattern: /\btest\s*\.\s*(use|describe\s*\.\s*configure)\s*\(/,
    reason: 'overriding runner options is not allowed',
  },
];

export interface ScriptGuardResult {
  readonly ok: boolean;
  readonly violations: readonly string[];
}

function hasStringMemberAccess(script: string): boolean {
  for (const match of script.matchAll(/([\w$]+|[)\]])\s*\[\s*['"`]/g)) {
    if (!KEYWORDS_BEFORE_ARRAY.has(match[1] as string)) return true;
  }
  return false;
}

export function checkScript(script: string): ScriptGuardResult {
  if (!script.trim()) return { ok: false, violations: ['script is empty'] };
  const violations: string[] = [];
  if (script.length > 60_000) violations.push('script is too long');

  const imports = [...script.matchAll(/\bimport\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g)].map(
    (match) => match[1] as string,
  );
  const bareImports = [...script.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)].map(
    (match) => match[1] as string,
  );
  for (const source of [...imports, ...bareImports]) {
    if (source !== '@playwright/test') violations.push(`import from "${source}" is not allowed`);
  }
  if (!imports.includes('@playwright/test')) violations.push('script must import @playwright/test');
  if (!/\btest\s*\(/.test(script)) violations.push('script must declare a test()');

  const code = script
    .replace(ALLOWED_ENV, 'E2E_ENV')
    .replace(STRINGS_AND_COMMENTS, (token) => (token.startsWith('/') ? ' ' : '""'));
  if (hasStringMemberAccess(code))
    violations.push('computed member access with strings is not allowed');
  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(code)) violations.push(rule.reason);
  }
  return { ok: violations.length === 0, violations: [...new Set(violations)] };
}

export function stripCodeFence(value: string): string {
  const fenced = /```(?:typescript|javascript|ts|js|tsx)?[^\n]*\n([\s\S]*?)```/i.exec(value);
  return (fenced?.[1] ?? value).trim();
}
