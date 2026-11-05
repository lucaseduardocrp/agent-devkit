import { describe, expect, it } from 'vitest';
import {
  descriptionAs,
  htmlToMarkdown,
  isHtmlDescription,
  markdownToHtml,
} from '../src/modules/pbi/description-format.js';

describe('description formats', () => {
  it('detects HTML and converts only when the format differs', () => {
    expect(isHtmlDescription('<p>x</p>')).toBe(true);
    expect(isHtmlDescription('a < b')).toBe(false);
    expect(descriptionAs('', 'html')).toBe('');
    expect(descriptionAs('  ', 'markdown')).toBe('  ');
    expect(descriptionAs('<p>x</p>', 'html')).toBe('<p>x</p>');
    expect(descriptionAs('**x**', 'markdown')).toBe('**x**');
    expect(descriptionAs('**x**', 'html')).toBe('<p><strong>x</strong></p>');
    expect(descriptionAs('<p><b>x</b></p>', 'markdown')).toBe('**x**');
  });

  it('renders Markdown blocks as HTML', () => {
    const markdown = [
      '# Title #',
      'Line one with `a<b>` and [link](https://x.dev?a=1&b=2)',
      'line two with ![img](https://x.dev/i.png), *em*, _also_, __strong__ and ~~gone~~',
      '',
      '---',
      '> quoted **text**',
      '> more',
      '',
      '```ts',
      'const a = 1 < 2;',
      '```',
      '',
      '| A | B |',
      '|---|:-:|',
      '| 1 | 2 |',
      '',
      '- one',
      '  continued',
      '  - nested',
      '    1. deep',
      '- [ ] todo',
      '- [x] done',
      '',
      '1) first',
      '2. second',
      '',
      '[bad](javascript:alert(1))',
      '- after paragraph',
      'Paragraph',
      '## Heading right after',
      '```',
      'unclosed',
    ].join('\r\n');
    expect(markdownToHtml(markdown)).toBe(
      [
        '<h1>Title</h1>',
        '<p>Line one with <code>a&lt;b&gt;</code> and <a href="https://x.dev?a=1&amp;b=2">link</a><br>',
        'line two with <img src="https://x.dev/i.png" alt="img">, <em>em</em>, <em>also</em>, <strong>strong</strong> and <del>gone</del></p>',
        '<hr>',
        '<blockquote><p>quoted <strong>text</strong><br>more</p></blockquote>',
        '<pre><code>const a = 1 &lt; 2;</code></pre>',
        '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
        '<ul><li>one continued<ul><li>nested<ol><li>deep</li></ol></li></ul></li><li>☐ todo</li><li>☑ done</li></ul>',
        '<ol><li>first</li><li>second</li></ol>',
        '<p><a href="#">bad</a>)</p>',
        '<ul><li>after paragraph</li></ul>',
        '<p>Paragraph</p>',
        '<h2>Heading right after</h2>',
        '<pre><code>unclosed</code></pre>',
      ].join(''),
    );
  });

  it('turns HTML into Markdown', () => {
    const html = `
      <!-- note -->
      <h2>Title</h2>
      <div>Text with <strong>bold</strong>, <em>em</em>, <s>old</s>, <code>x</code>,
        <a href="https://x.dev">link</a>, <a>plain</a>, <img src="i.png" alt="pic"><img>
        and &lt;tags&gt; &amp; &#65;&#x42; &nbsp;&unknown; <span>span</span><br>next line</div>
      <p><b></b></p>
      <blockquote><p>Quote</p><p>Two</p></blockquote>
      <pre><code>a &lt; b
c</code></pre>
      <ul><li>One<ul><li>Nested</li></ul></li><li><input type="checkbox" checked> Done</li>
        <li><input type="checkbox"> Todo</li><li><input type="text">Text</li></ul>
      <ol><li>First</li><li>Second</li></ol>
      <hr/>
      <table><thead><tr><th>A|1</th><th>B</th></tr></thead>
        <tbody><tr><td>x</td></tr></tbody></table>
      <table></table>
      <script>alert(1)</script><style>p{}</style>
      <section>End</section></i>unclosed < tag
    `;
    expect(htmlToMarkdown(html)).toBe(
      [
        '## Title',
        '',
        'Text with **bold**, _em_, ~~old~~, `x`, [link](https://x.dev), plain, ![pic](i.png) and <tags> & AB &unknown; span  ',
        'next line',
        '',
        '> Quote',
        '>',
        '> Two',
        '',
        '```',
        'a < b',
        'c',
        '```',
        '',
        '- One',
        '  - Nested',
        '- [x] Done',
        '- [ ] Todo',
        '- Text',
        '',
        '1. First',
        '2. Second',
        '',
        '---',
        '',
        '| A\\|1 | B |',
        '| --- | --- |',
        '| x |  |',
        '',
        'End',
        '',
        'unclosed < tag',
      ].join('\n'),
    );
  });

  it('handles the remaining tags and a table-like last line', () => {
    expect(markdownToHtml('a | b')).toBe('<p>a | b</p>');
    expect(htmlToMarkdown('<h1>T</h1><del>x</del><img src="i.png"><pre>a<br>b</pre>')).toBe(
      ['# T', '', '~~x~~![](i.png)', '', '```', 'a', 'b', '```'].join('\n'),
    );
  });
});
