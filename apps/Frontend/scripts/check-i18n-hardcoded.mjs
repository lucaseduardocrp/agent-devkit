import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const sourceRoot = path.resolve('src');
const violations = [];
const allowed = new Set([
  'components/layout/Sidebar.tsx|jsx|Agent DevKit',
  'features/agents/AgentsView.tsx|jsx|temp',
  'features/agents/AgentHubPanel.tsx|jsx|temp',
  // HTTP vocabulary, keyboard shortcuts, units and template placeholders are not translated.
  'features/apitests/integration/CodeEditorToolbar.tsx|title|Shift+Alt+F',
  'features/apitests/integration/RequestPane.tsx|aria-label|URL',
  'features/apitests/integration/RequestPane.tsx|title|Ctrl + Enter',
  'features/apitests/integration/RequestPane.tsx|jsx|· cURL',
  'features/apitests/integration/RequestPane.tsx|jsx|Bearer token',
  'features/apitests/integration/RequestPane.tsx|jsx|Basic',
  'features/apitests/integration/RequestPane.tsx|jsx|API key',
  'features/apitests/integration/RequestPane.tsx|jsx|Token',
  'features/apitests/integration/RequestPane.tsx|aria-label|Token',
  'features/apitests/integration/RequestPane.tsx|placeholder|{{token}}',
  'features/apitests/integration/RequestPane.tsx|placeholder|{{password}}',
  'features/apitests/integration/RequestPane.tsx|placeholder|{{apiKey}}',
  'features/apitests/integration/RequestPane.tsx|jsx|Header',
  'features/apitests/integration/RequestPane.tsx|jsx|Query',
  'features/apitests/integration/RequestPane.tsx|placeholder|token',
  'features/apitests/integration/RequestPane.tsx|jsx|JSON',
  'features/apitests/integration/RequestPane.tsx|jsx|Status',
  'features/apitests/integration/RequestPane.tsx|jsx|Body',
  'features/apitests/integration/RequestPane.tsx|placeholder|data.token',
  'features/apitests/integration/RequestPane.tsx|jsx|XML',
  'features/apitests/integration/RequestPane.tsx|jsx|Text',
  'features/apitests/integration/RequestPane.tsx|jsx|Form URL Encoded',
  'features/apitests/integration/RequestPane.tsx|jsx|Multipart Form',
  'features/apitests/IntegrationTestsView.tsx|jsx|Ctrl + Enter ·',
  'features/apitests/load/LoadPlanPane.tsx|jsx|ms',
  'features/apitests/load/LoadRunsPane.tsx|jsx|ms',
  'features/apitests/LoadTestsView.tsx|jsx|Ctrl + S ·',
  'features/shared/AttachmentPanel.tsx|placeholder|https://...',
  'features/agents/AgentsView.tsx|jsx|Ctrl + Enter',
  'features/brain/BrainView.tsx|jsx|.md',
  'features/brain/MarkdownViewer.tsx|jsx|mermaid',
  'features/connect/IntegrationConfigModal.tsx|jsx|Branch',
  'features/connect/IntegrationConfigModal.tsx|placeholder|main',
  'features/connect/IntegrationConfigModal.tsx|placeholder|http://localhost:3000',
  'features/connect/IntegrationConfigModal.tsx|placeholder|http://localhost:11434',
  'features/connect/IntegrationConfigModal.tsx|placeholder|Ex.: meu-modelo:latest',
  'features/connect/IntegrationConfigModal.tsx|placeholder|https://...',
  'features/design/DesignView.tsx|jsx|Design Systems',
  'features/design/DesignView.tsx|placeholder|<!doctype html>...',
  'features/design/DesignView.tsx|jsx|GitHub',
  'features/design/DesignView.tsx|jsx|Azure DevOps',
  'features/design/DesignView.tsx|jsx|Pull',
  'features/design/DesignView.tsx|jsx|Push',
  'features/e2e/E2eConfigForm.tsx|placeholder|http://localhost:8014',
  'features/e2e/E2eLocalRunnerPanel.tsx|jsx|· devkit',
  'features/e2e/E2eLocalRunnerPanel.tsx|jsx|devkit runner',
  'features/testplans/TestPlansView.tsx|jsx|Azure DevOps Test Cases',
  'features/testplans/TestPlansView.tsx|jsx|Azure:',
]);

function report(file, sourceFile, node, kind, value) {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!/\p{L}{2}/u.test(normalized)) return;
  const relative = path.relative(sourceRoot, file).replaceAll('\\', '/');
  if (allowed.has(`${relative}|${kind}|${normalized}`)) return;
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  violations.push(`${relative}:${line} [${kind}] ${normalized}`);
}

function inspect(file) {
  if (file.includes(`${path.sep}locales${path.sep}`)) return;
  const source = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const visit = (node) => {
    if (ts.isJsxText(node)) report(file, sourceFile, node, 'jsx', node.text);
    if (
      ts.isJsxAttribute(node) &&
      ['aria-label', 'title', 'placeholder', 'label'].includes(node.name.text) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    ) {
      report(file, sourceFile, node, node.name.text, node.initializer.text);
    }
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(sourceFile);
      const first = node.arguments[0];
      if (
        /(?:set[A-Za-z]*(?:Error|Toast|Feedback)|alert|confirm)$/.test(name) &&
        first &&
        (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) &&
        first.text
      ) {
        report(file, sourceFile, node, 'feedback', first.text);
      }
      const fallback = node.arguments[1];
      if (
        /(?:handleErrorResponse|ApiClientError)$/.test(name) &&
        fallback &&
        (ts.isStringLiteral(fallback) || ts.isNoSubstitutionTemplateLiteral(fallback))
      ) {
        report(file, sourceFile, node, 'api-error', fallback.text);
      }
    }
    if (ts.isNewExpression(node) && node.expression.getText(sourceFile) === 'ApiClientError') {
      const message = node.arguments?.[1];
      if (message && (ts.isStringLiteral(message) || ts.isNoSubstitutionTemplateLiteral(message))) {
        report(file, sourceFile, node, 'api-error', message.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target);
    else if (/\.tsx?$/.test(entry.name)) inspect(target);
  }
}

walk(sourceRoot);
if (violations.length) {
  console.error(`Hard-coded user-facing text found:\n${violations.join('\n')}`);
  process.exit(1);
}
console.log('Frontend i18n hard-coded text check passed.');
