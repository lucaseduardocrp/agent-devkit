import React from 'react';
import { useI18n } from '../../../lib/i18n/index.js';
import { cn } from '../../../lib/utils.js';
import type { ScriptFlow, Scripts } from '../api-test-types.js';
import { ScriptEditor } from './ScriptEditor.js';

// Scripts of the collection or a folder: the request editor's Script and Tests editors, with what
// they mean here (they run around every request inside) and, for the collection, the script flow.

export function ScriptsPanel({
  scripts,
  onChange,
  readOnly,
  section,
  scope,
  flow,
  onFlowChange,
}: {
  readonly scripts: Scripts | undefined;
  readonly onChange: (scripts: Scripts) => void;
  readonly readOnly: boolean;
  readonly section: 'script' | 'tests';
  readonly scope: 'collection' | 'folder';
  /** Collection only: how the scripts of the collection, folders and request are ordered. */
  readonly flow?: ScriptFlow;
  readonly onFlowChange?: (flow: ScriptFlow) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3" data-testid={`${scope}-${section}`}>
      <p className="text-xs text-[var(--text-secondary)]">
        {t(`apiTests.workbench.${section === 'tests' ? 'testsHint' : 'scriptHint'}.${scope}`)}
      </p>
      <ScriptEditor
        key={section}
        scripts={scripts}
        section={section}
        readOnly={readOnly}
        onChange={onChange}
      />
      {section === 'script' && onFlowChange && (
        <fieldset className="flex flex-col gap-2 rounded-md border border-[var(--border)] p-3">
          <legend className="px-1 text-xs font-semibold text-[var(--text-primary)]">
            {t('apiTests.workbench.scriptFlow')}
          </legend>
          {(['sandwich', 'sequential'] as const).map((value) => (
            <label
              key={value}
              className={cn(
                'flex cursor-pointer items-start gap-2 text-xs',
                readOnly && 'cursor-default',
              )}
            >
              <input
                type="radio"
                name="script-flow"
                className="mt-0.5"
                checked={(flow ?? 'sandwich') === value}
                disabled={readOnly}
                onChange={() => onFlowChange(value)}
              />
              <span>
                <span className="font-medium text-[var(--text-primary)]">
                  {t(`apiTests.workbench.flows.${value}`)}
                </span>
                <span className="block text-[var(--text-muted)]">
                  {t(`apiTests.workbench.flowHints.${value}`)}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}
