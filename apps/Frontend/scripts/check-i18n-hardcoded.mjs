import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// Every user-facing text lives in src/lib/i18n/locales (typed by src/lib/i18n/types.ts).
// This check fails on text written anywhere else. Brand names, protocol terms, shortcuts and
// examples that read the same in every language are allowed below, per file.

const sourceRoot = path.resolve('src');
const violations = [];

/** `file|kind|text` entries that are not translatable copy. */
const allowed = new Set([
  'components/layout/Sidebar.tsx|jsx|Agent DevKit',
  'features/agents/AgentHubPanel.tsx|jsx|temp',
  'features/agents/AgentsView.tsx|jsx|temp',
  'features/agents/AgentHubPanel.tsx|jsx|temp',
  // HTTP vocabulary, keyboard shortcuts, units and template placeholders are not translated.
  'features/apitests/integration/CodeEditorToolbar.tsx|title|Ctrl+B',
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
  'features/apitests/integration/ClientCertificates.tsx|placeholder|api.example.com',
  'features/apitests/integration/ClientCertificates.tsx|jsx|PEM',
  'features/apitests/integration/ClientCertificates.tsx|jsx|PFX / P12',
  'features/apitests/integration/ClientCertificates.tsx|placeholder|-----BEGIN CERTIFICATE-----',
  'features/apitests/integration/ClientCertificates.tsx|placeholder|-----BEGIN PRIVATE KEY-----',
  'features/apitests/integration/CollectionSettingsPane.tsx|placeholder|{{baseUrl}}',
  'features/apitests/integration/NewRequestDialog.tsx|jsx|URL',
  'features/apitests/integration/NewRequestDialog.tsx|aria-label|URL',
  'features/apitests/integration/ProxySettings.tsx|placeholder|proxy.example.com',
  'features/apitests/integration/ProxySettings.tsx|placeholder|localhost, *.internal',
  'features/apitests/integration/RequestSettingsEditor.tsx|placeholder|smoke, auth',
  'features/apitests/integration/RequestSettingsEditor.tsx|placeholder|graphql-ws',
  'features/apitests/integration/ResponseStreams.tsx|jsx|ms',
  'features/shared/AttachmentPanel.tsx|placeholder|https://...',
  'features/agents/AgentsView.tsx|jsx|Ctrl + Enter',
  'features/apitests/IntegrationTestsView.tsx|jsx|Ctrl + Enter ·',
  'features/apitests/LoadTestsView.tsx|jsx|Ctrl + S ·',
  'features/apitests/integration/AuthEditor.tsx|label|Header',
  'features/apitests/integration/AuthEditor.tsx|label|Query',
  'features/apitests/integration/BodyEditor.tsx|label|Text',
  'features/apitests/integration/BodyEditor.tsx|label|Form URL Encoded',
  'features/apitests/integration/BodyEditor.tsx|label|Multipart Form',
  'features/apitests/integration/BodyEditor.tsx|placeholder|SELECT ?s WHERE { ?s ?p ?o } LIMIT 10',
  'features/apitests/integration/ClientCertificates.tsx|placeholder|api.example.com',
  'features/apitests/integration/ClientCertificates.tsx|jsx|PEM',
  'features/apitests/integration/ClientCertificates.tsx|jsx|PFX / P12',
  'features/apitests/integration/ClientCertificates.tsx|placeholder|-----BEGIN CERTIFICATE-----',
  'features/apitests/integration/ClientCertificates.tsx|placeholder|-----BEGIN PRIVATE KEY-----',
  'features/apitests/integration/CodeEditorToolbar.tsx|title|Ctrl+B',
  'features/apitests/integration/CollectionSettingsPane.tsx|placeholder|{{baseUrl}}',
  'features/apitests/integration/NewRequestDialog.tsx|jsx|URL',
  'features/apitests/integration/NewRequestDialog.tsx|aria-label|URL',
  'features/apitests/integration/ProxySettings.tsx|placeholder|proxy.example.com',
  'features/apitests/integration/ProxySettings.tsx|placeholder|localhost, *.internal',
  'features/apitests/integration/RequestPane.tsx|aria-label|URL',
  'features/apitests/integration/RequestPane.tsx|title|Ctrl + Enter',
  'features/apitests/integration/RequestPane.tsx|placeholder|token',
  'features/apitests/integration/RequestPane.tsx|placeholder|data.token',
  'features/apitests/integration/RequestSettingsEditor.tsx|placeholder|smoke, auth',
  'features/apitests/integration/RequestSettingsEditor.tsx|placeholder|graphql-ws',
  'features/apitests/integration/ResponseStreams.tsx|jsx|ms',
  'features/apitests/load/LoadPlanPane.tsx|jsx|ms',
  'features/apitests/load/LoadRunsPane.tsx|jsx|ms',
  'features/brain/BrainView.tsx|jsx|.md',
  'features/brain/BrainView.tsx|detail|Azure DevOps',
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
  'features/e2e/E2eConfigForm.tsx|jsx|devkit bridge --origin',
  'features/e2e/E2eLocalRunnerPanel.tsx|jsx|· devkit',
  'features/e2e/E2eLocalRunnerPanel.tsx|jsx|devkit runner',
  'features/e2e/E2eLocalRunnerPanel.tsx|jsx|devkit login --api-url',
  'features/e2e/E2eLocalRunnerPanel.tsx|jsx|devkit e2e run',
  'features/issues/agent-brief-prompt.tsx|aria-label|Prompt',
  'features/notifications/NotificationActionEditor.tsx|placeholder|Issue #{{issue.number}}: {{issue.title}}',
  'features/shared/AttachmentPanel.tsx|placeholder|https://...',
  // Azure DevOps field names, kept as Azure shows them (the copy refers to them the same way).
  'features/testplans/AzureExportFields.tsx|label|Area Path',
  'features/testplans/AzureExportFields.tsx|label|Assigned To',
  'features/testplans/AzureExportFields.tsx|label|State',
  'features/testplans/TestPlansView.tsx|jsx|Azure DevOps Test Cases',
  'features/testplans/TestPlansView.tsx|jsx|Azure:',
]);

/** Catalogs of product, model and protocol names, generated code, and data mirrored from the API. */
const ignoredFiles = new Set([
  'features/agents/agent-templates.ts',
  'features/apitests/integration/code-generation.ts',
  'features/apitests/integration/integration-model.ts',
  'features/connect/llm-model-catalog.ts',
  'features/testplans/export-csv.ts',
  'features/work-item-types/work-item-types.tsx',
]);

const textAttributes = new Set([
  'aria-label',
  'aria-description',
  'title',
  'placeholder',
  'label',
  'alt',
  'description',
  'hint',
  'tooltip',
  'resizeLabel',
  'loadingMessage',
  'emptyMessage',
]);
const textProperties = new Set([
  'title',
  'message',
  'label',
  'desc',
  'description',
  'detail',
  'placeholder',
  'hint',
  'tooltip',
  'emptyMessage',
  'loadingMessage',
]);

const normalize = (value) => value.trim().replace(/\s+/g, ' ');
/** Words a person reads, as opposed to keys, ids, CSS classes or code. */
const isProse = (value) => {
  const text = normalize(value);
  if (!/\p{L}{2}/u.test(text)) return false;
  return /[^\x00-\x7F]/.test(text) || /\p{L}\s+\p{L}/u.test(text) || /^\p{Lu}\p{Ll}/u.test(text);
};

function report(file, sourceFile, node, kind, value, { prose = false } = {}) {
  const normalized = normalize(value);
  if (!/\p{L}{2}/u.test(normalized)) return;
  if (prose && !isProse(normalized)) return;
  const relative = path.relative(sourceRoot, file).replaceAll('\\', '/');
  if (allowed.has(`${relative}|${kind}|${normalized}`)) return;
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  violations.push(`${relative}:${line} [${kind}] ${normalized}`);
}

/** The literal texts an expression can evaluate to: `'a'`, `` `a ${b}` ``, `x ? 'a' : 'b'`, `x ?? 'a'`. */
function literalLeaves(node) {
  if (ts.isParenthesizedExpression(node)) return literalLeaves(node.expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node];
  if (ts.isTemplateExpression(node)) return [node];
  if (ts.isConditionalExpression(node))
    return [...literalLeaves(node.whenTrue), ...literalLeaves(node.whenFalse)];
  if (
    ts.isBinaryExpression(node) &&
    [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(
      node.operatorToken.kind,
    )
  )
    return literalLeaves(node.right);
  return [];
}
const leafText = (node) =>
  ts.isTemplateExpression(node)
    ? node.head.text + node.templateSpans.map((span) => ` ${span.literal.text}`).join('')
    : node.text;

const isLocaleName = (node) =>
  (ts.isStringLiteral(node) || ts.isIdentifier(node)) && /^(pt-BR|en-US)$/.test(node.text);

function inspect(file) {
  if (file.includes(`${path.sep}lib${path.sep}i18n${path.sep}`)) return;
  const relative = path.relative(sourceRoot, file).replaceAll('\\', '/');
  if (ignoredFiles.has(relative)) return;
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

    // Text as a JSX child: {cond ? 'Sim' : 'Yes'}
    if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
      for (const leaf of literalLeaves(node.expression))
        report(file, sourceFile, leaf, 'jsx', leafText(leaf), { prose: true });
    }

    if (ts.isJsxAttribute(node) && textAttributes.has(node.name.getText(sourceFile))) {
      const name = node.name.getText(sourceFile);
      if (node.initializer && ts.isStringLiteral(node.initializer)) {
        report(file, sourceFile, node, name, node.initializer.text);
      } else if (
        node.initializer &&
        ts.isJsxExpression(node.initializer) &&
        node.initializer.expression
      ) {
        for (const leaf of literalLeaves(node.initializer.expression))
          report(file, sourceFile, leaf, name, leafText(leaf), { prose: true });
      }
    }

    // { title: 'Enviando…' }, { message: `Falha ${x}` }
    if (
      ts.isPropertyAssignment(node) &&
      textProperties.has(node.name.getText(sourceFile).replace(/['"]/g, ''))
    ) {
      for (const leaf of literalLeaves(node.initializer))
        report(file, sourceFile, leaf, node.name.getText(sourceFile), leafText(leaf), {
          prose: true,
        });
    }

    // Copy kept per locale outside the dictionaries: { 'pt-BR': {...}, 'en-US': {...} }
    if (
      ts.isObjectLiteralExpression(node) &&
      node.properties.some(
        (property) => ts.isPropertyAssignment(property) && isLocaleName(property.name),
      )
    ) {
      report(file, sourceFile, node, 'inline-dictionary', 'object keyed by locale');
    }
    // Copy chosen by comparing the locale: locale === 'pt-BR' ? '...' : '...'
    if (
      ts.isConditionalExpression(node) &&
      ts.isBinaryExpression(node.condition) &&
      isLocaleName(node.condition.right) &&
      literalLeaves(node.whenTrue).length + literalLeaves(node.whenFalse).length > 0
    ) {
      report(file, sourceFile, node, 'locale-branch', node.condition.getText(sourceFile));
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
  console.error(
    `Hard-coded user-facing text found (move it to src/lib/i18n/locales):\n${violations.join('\n')}`,
  );
  process.exit(1);
}
console.log('Frontend i18n hard-coded text check passed.');
