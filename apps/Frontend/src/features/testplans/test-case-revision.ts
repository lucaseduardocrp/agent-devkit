import type { E2eCaseDraft } from '../../lib/api-client.js';
import { fenceDiagrams } from './scenario-markdown.js';
import type { TestCase } from './TestPlansView.js';

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

/**
 * The text of a description (Markdown, or the HTML of older cases): images go away and each block
 * ends in a line break.
 */
export function richTextToPlain(html: string): string {
  const spaced = html
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<\/(?:p|div|h[1-6]|li|ul|ol)>|<br\s*\/?>/gi, '\n');
  const text = decodeHtmlEntities(spaced.replace(/<[^>]+>/g, ''));
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The case the way the AI reads it: plain text, with the steps as the person wrote them. */
export function caseToDraft(testCase: TestCase): E2eCaseDraft {
  return {
    title: testCase.title,
    description: richTextToPlain(testCase.scenario),
    steps: (testCase.steps ?? []).map(({ action, expectedResult }) => ({ action, expectedResult })),
  };
}

/**
 * The case with what the AI rewrote. A description that says the same keeps the editor's own
 * Markdown (images included); the rest is replaced by what the AI wrote.
 */
export function applyRevision(testCase: TestCase, revision: E2eCaseDraft): TestCase {
  const sameDescription =
    collapse(revision.description) === collapse(richTextToPlain(testCase.scenario));
  return {
    ...testCase,
    title: revision.title,
    scenario: sameDescription ? testCase.scenario : fenceDiagrams(revision.description.trim()),
    steps: revision.steps.map((step, index) => ({
      order: index + 1,
      action: step.action,
      expectedResult: step.expectedResult,
    })),
  };
}
