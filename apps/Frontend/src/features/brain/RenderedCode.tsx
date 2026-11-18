import { useEffect, useId, useState } from 'react';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import gherkin from 'highlight.js/lib/languages/gherkin';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import 'highlight.js/styles/github-dark.css';
import { useI18n } from '../../lib/i18n/index.js';

for (const [name, grammar] of Object.entries({
  bash,
  csharp,
  css,
  diff,
  dockerfile,
  gherkin,
  go,
  ini,
  java,
  javascript,
  json,
  markdown,
  powershell,
  python,
  sql,
  typescript,
  xml,
  yaml,
})) {
  hljs.registerLanguage(name, grammar);
}
hljs.registerLanguage('dbml', () => ({
  keywords: {
    keyword: 'Table Ref Enum Project TableGroup Note indexes as',
    literal: 'pk increment unique null default ref',
  },
  contains: [
    { scope: 'comment', begin: '//', end: '$' },
    { scope: 'string', begin: '"', end: '"' },
    { scope: 'number', begin: '\\b\\d+\\b' },
  ],
}));

const languageAliases: Readonly<Record<string, string>> = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  html: 'xml',
  svg: 'xml',
  shell: 'bash',
  sh: 'bash',
  yml: 'yaml',
  dbdiagram: 'dbml',
  cs: 'csharp',
  'c#': 'csharp',
  feature: 'gherkin',
  bdd: 'gherkin',
  md: 'markdown',
  ps1: 'powershell',
  pwsh: 'powershell',
  py: 'python',
  toml: 'ini',
  docker: 'dockerfile',
  patch: 'diff',
  xhtml: 'xml',
  postgres: 'sql',
  postgresql: 'sql',
  mysql: 'sql',
  tsql: 'sql',
  plsql: 'sql',
  sqlite: 'sql',
  zsh: 'bash',
  console: 'bash',
};

interface RenderedCodeProps {
  readonly code: string;
  readonly language: string;
}

/** The HTML the highlighter draws for a code, or null for a language it does not know. */
function highlightHtml(code: string, language: string): string | null {
  const normalizedLanguage = language.toLowerCase().split(/\s+/)[0]!;
  const grammar = languageAliases[normalizedLanguage] ?? normalizedLanguage;
  return hljs.getLanguage(grammar)
    ? hljs.highlight(code, { language: grammar, ignoreIllegals: true }).value
    : null;
}

/** A piece of one line and the highlighter classes it is drawn with ('' for plain text). */
export interface CodeToken {
  readonly text: string;
  readonly className: string;
}

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#x27;': "'",
};
/** Past this length the editor shows the text plain instead of highlighting on every keystroke. */
const MAX_HIGHLIGHT = 200_000;
const HTML_PART = /<span class="([^"]*)">|<\/span>|([^<]+)/g;

/**
 * The highlighted code line by line, for a view that draws each line itself (the editor). A token
 * that spans lines (a block comment) is cut at each break and carries its classes on every line.
 * Null when the language is not known or the code is too long to highlight on every keystroke.
 */
export function highlightLines(code: string, language: string): CodeToken[][] | null {
  if (code.length > MAX_HIGHLIGHT) return null;
  const html = highlightHtml(code, language);
  if (html === null) return null;
  const lines: CodeToken[][] = [[]];
  const open: string[] = [];
  for (const [, opening, text] of html.matchAll(HTML_PART)) {
    if (opening !== undefined) open.push(opening);
    else if (text === undefined) open.pop();
    else {
      const plain = text.replace(/&(?:amp|lt|gt|quot|#x27);/g, (entity) => ENTITIES[entity]!);
      plain.split('\n').forEach((part, at) => {
        if (at > 0) lines.push([]);
        if (part) lines[lines.length - 1]!.push({ text: part, className: open.join(' ') });
      });
    }
  }
  return lines;
}

export function RenderedCode({ code, language }: RenderedCodeProps) {
  const highlighted = highlightHtml(code, language);

  return (
    <pre className="thin-scrollbar overflow-x-auto p-3.5 font-mono text-xs leading-relaxed text-[#e0e0e0] whitespace-pre select-text">
      {highlighted ? (
        <code className="hljs !bg-transparent" dangerouslySetInnerHTML={{ __html: highlighted }} />
      ) : (
        <code>{code}</code>
      )}
    </pre>
  );
}

export function MermaidDiagram({ code }: { readonly code: string }) {
  const { t } = useI18n();
  const reactId = useId();
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setImageUrl(null);
    const renderDiagram = async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' });
        const id = `diagram-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
        const { svg } = await mermaid.render(id, code);
        if (active) setImageUrl(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      } catch {
        // Keep the source visible when a diagram cannot be rendered.
      }
    };
    void renderDiagram();
    return () => {
      active = false;
    };
  }, [code, reactId]);

  return imageUrl ? (
    <div className="overflow-x-auto border-b border-[#202024] bg-[#17191e] p-4">
      <img src={imageUrl} alt={t('brain.mermaidDiagram')} className="mx-auto max-w-none" />
    </div>
  ) : null;
}
