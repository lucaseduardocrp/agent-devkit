import type { VariableSuggestion } from './variables-context.js';

// What the `{{` autocomplete of VariableInput (one line) and CodeEditor (a body) have in common.

/** The variable being typed right before the caret: `{{bas|`. */
const TYPING = /\{\{\s*([\w.$-]*)$/;

/** The `{{name` being typed at the end of `textBeforeCaret`: where it starts and what was typed. */
export function typingMatch(textBeforeCaret: string): { start: number; query: string } | null {
  const match = TYPING.exec(textBeforeCaret);
  return match ? { start: match.index, query: match[1]! } : null;
}

/** The suggestions that fit what was typed, those that start with it first. */
export function rankSuggestions(
  variables: readonly VariableSuggestion[],
  query: string,
): VariableSuggestion[] {
  const text = query.toLowerCase();
  return variables
    .filter((variable) => variable.name.toLowerCase().includes(text))
    .sort(
      (a, b) =>
        Number(!a.name.toLowerCase().startsWith(text)) -
        Number(!b.name.toLowerCase().startsWith(text)),
    )
    .slice(0, 8);
}

/** The text after the caret that completing a suggestion replaces: the rest of an existing token. */
export const restOfToken = (textAfterCaret: string) =>
  textAfterCaret.replace(/^[\w.$-]*\s*\}\}/, '');

/** Width of `text` in the field's font, to open the suggestions under the `{{`. */
export function textWidth(element: HTMLInputElement | HTMLTextAreaElement, text: string): number {
  const style = window.getComputedStyle(element);
  const probe = document.createElement('span');
  probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${style.font}`;
  probe.textContent = text;
  document.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return width;
}
