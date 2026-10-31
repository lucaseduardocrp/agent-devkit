import React, { useRef, useState } from 'react';
import { Button } from '../../../components/ui/button.js';
import { useI18n } from '../../../lib/i18n/index.js';
import type { Scripts } from '../api-test-types.js';
import { CodeEditor, type CodeEditorHandle } from './CodeEditor.js';
import { EditorPopover } from './EditorPopover.js';

// Scripts of a request: "Before request" / "After response" (Script tab) and the tests (Tests
// tab), in JavaScript calling the `adk` API, with a menu of ready-made snippets as in Postman.

export type ScriptPhase = 'preRequest' | 'postResponse';

export const SNIPPETS = [
  { id: 'setVar', code: "adk.setVar('name', 'value');" },
  { id: 'getVar', code: "const value = adk.getVar('name');" },
  { id: 'getEnvVar', code: "const baseUrl = adk.getEnvVar('baseUrl');" },
  { id: 'setEnvVar', code: "adk.setEnvVar('name', 'value');" },
  { id: 'setHeader', code: "req.setHeader('X-Request-Id', adk.getVar('requestId'));" },
  {
    id: 'testStatus',
    code: "test('status is 200', () => {\n  expect(res.getStatus()).to.equal(200);\n});",
  },
  {
    id: 'testJson',
    code: "test('body has an id', () => {\n  expect(res.getBody()).to.have.property('id');\n});",
  },
  { id: 'readBody', code: 'const body = res.getBody();\nconsole.log(body);' },
  { id: 'saveToken', code: "adk.setVar('token', res.getBody().token);" },
  {
    id: 'sendRequest',
    code: "const response = await adk.sendRequest({\n  method: 'GET',\n  url: adk.getEnvVar('baseUrl') + '/health',\n});\nconsole.log(response.status);",
  },
  { id: 'setNextRequest', code: "adk.setNextRequest('Request name');" },
  { id: 'skipRequest', code: 'adk.runner.skipRequest();' },
] as const;

export type SnippetId = (typeof SNIPPETS)[number]['id'];

const PLACEHOLDERS = {
  preRequest: "// Runs before the request\n// req.setHeader('X-Trace-Id', adk.getVar('traceId'));",
  postResponse: "// Runs after the response\n// adk.setVar('token', res.getBody().token);",
  tests: "test('responds with 200', () => {\n  expect(res.getStatus()).to.equal(200);\n});",
} as const;

function SnippetsMenu({ onPick }: { readonly onPick: (code: string) => void }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <EditorPopover
      icon="ti-code-plus"
      label={t('apiTests.protocol.snippets')}
      title={t('apiTests.protocol.snippets')}
      width={320}
      testId="snippets"
    >
      {(close) => (
        <ul className="flex flex-col overflow-y-auto py-1" role="list">
          {SNIPPETS.map((snippet) => (
            <li key={snippet.id}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full justify-start rounded-none font-normal"
                onClick={() => {
                  close();
                  onPick(snippet.code);
                }}
              >
                {t(`apiTests.protocol.snippetList.${snippet.id}`)}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </EditorPopover>
  );
}

/** The Script tab (two phases) or the Tests tab of a request. */
export function ScriptEditor({
  scripts,
  section,
  readOnly,
  onChange,
}: {
  readonly scripts: Scripts | undefined;
  readonly section: 'script' | 'tests';
  readonly readOnly: boolean;
  readonly onChange: (scripts: Scripts) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const editor = useRef<CodeEditorHandle>(null);
  const [phase, setPhase] = useState<ScriptPhase>(
    !scripts?.preRequest && scripts?.postResponse ? 'postResponse' : 'preRequest',
  );
  const name: keyof Scripts = section === 'tests' ? 'tests' : phase;
  const label =
    section === 'tests' ? t('apiTests.protocol.tests') : t(`apiTests.protocol.${phase}`);
  return (
    <div className="flex h-full flex-col gap-2" data-testid={`request-${section}`}>
      <div className="flex flex-wrap items-center gap-2">
        {section === 'script' && (
          <div
            className="flex items-center gap-0.5 rounded-md border border-[var(--border)] p-0.5"
            role="tablist"
            aria-label={t('apiTests.protocol.script')}
          >
            {(['preRequest', 'postResponse'] as const).map((value) => (
              <Button
                key={value}
                type="button"
                role="tab"
                size="sm"
                aria-selected={phase === value}
                variant={phase === value ? 'secondary' : 'ghost'}
                className="h-7 gap-1 px-2.5"
                onClick={() => setPhase(value)}
              >
                {t(`apiTests.protocol.${value}`)}
                {scripts?.[value]?.trim() && (
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-[var(--fill-accent)]"
                    aria-hidden="true"
                  />
                )}
              </Button>
            ))}
          </div>
        )}
        <span className="flex-1" />
        {!readOnly && <SnippetsMenu onPick={(code) => editor.current?.insertTemplate(code)} />}
      </div>
      <CodeEditor
        key={name}
        ref={editor}
        value={scripts?.[name] ?? ''}
        onChange={(value) => onChange({ ...scripts, [name]: value })}
        readOnly={readOnly}
        language="javascript"
        label={label}
        placeholder={PLACEHOLDERS[name]}
      />
      <p className="text-xs text-[var(--text-muted)]">{t('apiTests.protocol.scriptHint')}</p>
    </div>
  );
}
