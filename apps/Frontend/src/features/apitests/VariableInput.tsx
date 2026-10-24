import React, { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Input, type InputProps } from '../../components/ui/input.js';
import { useI18n } from '../../lib/i18n/index.js';
import { cn } from '../../lib/utils.js';
import { VariablesContext, type VariableSuggestion } from './variables-context.js';

const TOKEN = /(\{\{[^{}]*\}\})/;
/** The variable being typed right before the caret: `{{bas|`. */
const TYPING = /\{\{\s*([\w.$-]*)$/;

interface Menu {
  readonly start: number;
  readonly items: readonly VariableSuggestion[];
  readonly index: number;
  readonly left: number;
  readonly top: number;
}

/** Width of `text` in the input's font, to open the suggestions under the `{{`. */
function textWidth(element: HTMLInputElement, text: string): number {
  const style = window.getComputedStyle(element);
  const probe = document.createElement('span');
  probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${style.font}`;
  probe.textContent = text;
  document.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return width;
}

export interface VariableInputProps extends Omit<InputProps, 'value' | 'onChange'> {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly mono?: boolean;
  readonly containerClassName?: string;
}

/**
 * The app's Input with `{{variable}}` support, as in Bruno: known variables are highlighted
 * (unknown ones in red) and typing `{{` suggests the variables of the environment, the
 * collection, the captures and the dynamic helpers.
 */
export function VariableInput({
  value,
  onValueChange,
  mono,
  className,
  containerClassName,
  disabled,
  inputSize,
  onKeyDown,
  onBlur,
  ...rest
}: VariableInputProps): React.JSX.Element {
  const { t } = useI18n();
  const variables = useContext(VariablesContext);
  const input = useRef<HTMLInputElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<Menu | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  if (!variables) {
    return (
      <Input
        {...rest}
        inputSize={inputSize}
        disabled={disabled}
        className={cn(mono && 'font-mono', className)}
        value={value}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        onChange={(event) => onValueChange(event.target.value)}
      />
    );
  }

  const known = new Set(variables.map((variable) => variable.name));
  const syncScroll = () => {
    if (backdrop.current && input.current) backdrop.current.scrollLeft = input.current.scrollLeft;
  };

  const refresh = () => {
    syncScroll();
    const element = input.current;
    if (!element || document.activeElement !== element) return setMenu(null);
    const caret = element.selectionStart ?? element.value.length;
    const match = TYPING.exec(element.value.slice(0, caret));
    if (!match) return setMenu(null);
    const query = match[1]!.toLowerCase();
    const items = variables
      .filter((variable) => variable.name.toLowerCase().includes(query))
      .sort(
        (a, b) =>
          Number(!a.name.toLowerCase().startsWith(query)) -
          Number(!b.name.toLowerCase().startsWith(query)),
      )
      .slice(0, 8);
    if (!items.length) return setMenu(null);
    const rect = element.getBoundingClientRect();
    const padding = parseFloat(window.getComputedStyle(element).paddingLeft) || 0;
    const left =
      rect.left +
      padding +
      textWidth(element, element.value.slice(0, match.index)) -
      element.scrollLeft;
    setMenu((current) => ({
      start: match.index,
      items,
      index: current?.start === match.index ? Math.min(current.index, items.length - 1) : 0,
      left: Math.max(8, Math.min(left, window.innerWidth - 328)),
      top: rect.bottom + 4,
    }));
  };

  const choose = (suggestion: VariableSuggestion) => {
    const element = input.current;
    if (!element || !menu) return;
    const caret = element.selectionStart ?? value.length;
    // Completing inside an existing token replaces the rest of it.
    const after = value.slice(caret).replace(/^[\w.$-]*\s*\}\}/, '');
    const inserted = `{{${suggestion.name}}}`;
    onValueChange(value.slice(0, menu.start) + inserted + after);
    setMenu(null);
    const position = menu.start + inserted.length;
    window.requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(position, position);
      syncScroll();
    });
  };

  return (
    <div className={cn('relative w-full min-w-0', containerClassName)}>
      <Input
        {...rest}
        ref={input}
        inputSize={inputSize}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={Boolean(menu)}
        className={cn(
          'text-transparent caret-[var(--text-primary)]',
          mono && 'font-mono',
          className,
        )}
        value={value}
        onChange={(event) => {
          onValueChange(event.target.value);
          refresh();
        }}
        onKeyDown={(event) => {
          if (menu) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const step = event.key === 'ArrowDown' ? 1 : -1;
              setMenu({
                ...menu,
                index: (menu.index + step + menu.items.length) % menu.items.length,
              });
              return;
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              event.preventDefault();
              choose(menu.items[menu.index]!);
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setMenu(null);
              return;
            }
          }
          onKeyDown?.(event);
        }}
        onKeyUp={(event) => {
          if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) refresh();
        }}
        onClick={refresh}
        onScroll={syncScroll}
        onBlur={(event) => {
          setMenu(null);
          onBlur?.(event);
        }}
      />
      {/* Same box and font as the input, on top of it: shows the text with the variables colored. */}
      <div
        ref={backdrop}
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-0 flex items-center overflow-hidden whitespace-pre border border-transparent text-[var(--text-primary)]',
          inputSize === 'sm' ? 'px-2.5 text-xs' : 'px-3.5 text-sm',
          mono && 'font-mono',
          className?.includes('text-xs') && 'text-xs',
          disabled && 'opacity-50',
        )}
      >
        <span>
          {value.split(TOKEN).map((part, index) => {
            if (!TOKEN.test(part)) return part;
            const name = part.slice(2, -2).trim();
            return (
              <span
                key={index}
                className={cn(
                  'rounded-sm',
                  known.has(name)
                    ? 'bg-[var(--bg-success)] text-[var(--text-success)]'
                    : 'bg-[var(--bg-danger)] text-[var(--text-danger)]',
                )}
              >
                {part}
              </span>
            );
          })}
          {/* Keeps the scroll width equal to the input's, past the last character. */}
          {'  '}
        </span>
      </div>
      {menu &&
        createPortal(
          <div
            role="listbox"
            aria-label={t('apiTests.ui.variables')}
            className="fixed z-[1000] w-80 overflow-hidden rounded-md border border-border bg-surface-1 py-1 shadow-xl"
            style={{ left: menu.left, top: menu.top }}
            data-testid="variable-suggestions"
          >
            {menu.items.map((item, index) => (
              <div
                key={item.name}
                role="option"
                aria-selected={index === menu.index}
                className={cn(
                  'flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs',
                  index === menu.index && 'bg-[var(--fill-ghost-hover)]',
                )}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(item);
                }}
                onMouseEnter={() => setMenu({ ...menu, index })}
              >
                <span className="shrink-0 font-mono text-[var(--text-primary)]">{item.name}</span>
                <span className="min-w-0 flex-1 truncate text-right font-mono text-[var(--text-muted)]">
                  {item.secret ? '••••••' : (item.value ?? '')}
                </span>
                <span className="shrink-0 rounded bg-[var(--surface-2)] px-1.5 py-px text-[10px] text-[var(--text-secondary)]">
                  {t(`apiTests.ui.variableSources.${item.source}`)}
                </span>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
