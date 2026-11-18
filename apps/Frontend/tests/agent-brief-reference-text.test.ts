import { describe, expect, it } from 'vitest';
import { locateExcerpt, plainText } from '../src/features/issues/agent-brief-reference-text.js';

describe('locateExcerpt', () => {
  const body = 'Intro.\n\nThe manager approves\nor rejects the request.\n\nClosing.';

  it('finds a passage as written', () => {
    expect(locateExcerpt(body, 'Closing.')).toEqual({
      start: body.indexOf('Closing.'),
      end: body.length,
    });
  });

  it('finds a passage whose line breaks and spaces differ', () => {
    const found = locateExcerpt(body, 'The manager   approves or rejects the request.');
    expect(body.slice(found!.start, found!.end)).toBe(
      'The manager approves\nor rejects the request.',
    );
  });

  it('falls back to the start of a long passage whose end changed', () => {
    const text = 'The manager approves or rejects the request. '.repeat(5);
    const page = `Intro. ${text.slice(0, 200)} but the page changed from here on.`;
    const found = locateExcerpt(page, text);
    // The whole passage is not there, but its first 160 characters are.
    expect(found).toEqual({
      start: page.indexOf('The manager'),
      end: page.indexOf('The manager') + 160,
    });
  });

  it('knows when the passage is not there', () => {
    expect(locateExcerpt(body, 'Never written')).toBeNull();
    expect(locateExcerpt(body, '   ')).toBeNull();
  });

  it('escapes regular expression characters', () => {
    expect(locateExcerpt('cost (USD) is 5.00 + tax', '(USD) is 5.00 + tax')).not.toBeNull();
    expect(locateExcerpt('cost (USD)', '.*')).toBeNull();
  });
});

describe('plainText', () => {
  it('keeps plain text as it is', () => {
    expect(plainText('a < b and c > d')).toBe('a < b and c > d');
    expect(plainText(undefined)).toBe('');
    expect(plainText(null)).toBe('');
    expect(plainText('')).toBe('');
  });

  it('reads the text of HTML, one block per line, without running anything', () => {
    const html =
      '<h2>Title</h2><p>One <b>bold</b></p><ul><li>a</li><li>b</li></ul><script>x()</script>';
    expect(plainText(html)).toBe('Title\nOne bold\na\nb');
  });
});
