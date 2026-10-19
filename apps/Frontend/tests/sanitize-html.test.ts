import { afterEach, describe, expect, it, vi } from 'vitest';
import { INLINE_HTML_TAG, sanitizeHtml } from '../src/lib/sanitize-html.js';

describe('sanitizeHtml', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('removes dangerous elements and attributes while keeping safe markup', () => {
    const html = sanitizeHtml(
      '<div class="x" onclick="evil()"><script>alert(1)</script><style>p{}</style>' +
        '<custom-tag><b>Kept</b></custom-tag><table><tr><td colspan="2" style="color:red">Cell</td></tr></table>' +
        '<details open><summary>More</summary>Body</details></div>',
    );
    expect(html).not.toMatch(/script|style|onclick|class=|custom-tag/);
    expect(html).toContain('<b>Kept</b>');
    expect(html).toContain('<td colspan="2">Cell</td>');
    expect(html).toContain('<details open="">');
  });

  it('keeps safe links opening in a new tab and drops unsafe hrefs', () => {
    const html = sanitizeHtml(
      '<a href="https://example.com" title="t">ok</a><a href="javascript:alert(1)">bad</a><a>none</a>',
    );
    expect(html).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">ok</a>',
    );
    expect(html).toContain('<a target="_blank" rel="noopener noreferrer">bad</a>');
    expect(html).toContain('<a target="_blank" rel="noopener noreferrer">none</a>');
  });

  it('strips tags when DOMParser is unavailable', () => {
    vi.stubGlobal('DOMParser', undefined);
    expect(sanitizeHtml('<b>bold</b>')).toBe(' bold ');
  });

  it('detects inline HTML tags', () => {
    expect(INLINE_HTML_TAG.test('Text <strong>x</strong>')).toBe(true);
    expect(INLINE_HTML_TAG.test('List<String>')).toBe(false);
  });
});
