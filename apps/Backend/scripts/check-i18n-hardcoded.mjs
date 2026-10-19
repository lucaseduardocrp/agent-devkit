import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('src');
const ptSource = fs.readFileSync(path.join(root, 'shared/locales/pt-BR.ts'), 'utf8');
const enSource = fs.readFileSync(path.join(root, 'shared/locales/en-US.ts'), 'utf8');
const keys = (source) =>
  new Set([...source.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]));
const ptKeys = keys(ptSource);
const enKeys = keys(enSource);
const violations = [];

for (const key of ptKeys) if (!enKeys.has(key)) violations.push(`Missing en-US error code: ${key}`);
for (const key of enKeys) if (!ptKeys.has(key)) violations.push(`Missing pt-BR error code: ${key}`);

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target);
    else if (entry.name.endsWith('.ts') && !target.includes(`${path.sep}locales${path.sep}`)) {
      const source = fs.readFileSync(target, 'utf8');
      for (const match of source.matchAll(/new ApplicationError\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g)) {
        if (!ptKeys.has(match[1])) {
          violations.push(`${path.relative(root, target)} uses untranslated code ${match[1]}`);
        }
      }
      if (/\b(?:response|res)\.status\([^)]*\)\.json\(\s*\{[^}]*message:\s*['"]/s.test(source)) {
        violations.push(`${path.relative(root, target)} exposes a literal JSON message`);
      }
      if (/details:\s*[^\n]*issue\.message/.test(source)) {
        violations.push(`${path.relative(root, target)} exposes a raw validation message`);
      }
    }
  }
}

walk(root);
if (violations.length) {
  console.error(`Backend i18n contract violations:\n${violations.join('\n')}`);
  process.exit(1);
}
console.log('Backend i18n contract check passed.');
