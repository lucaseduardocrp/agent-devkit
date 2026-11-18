import { describe, expect, it } from 'vitest';
import {
  editorToMarkdown,
  markdownOutline,
  markdownToEditorHtml,
  outlineOffsets,
} from '../src/features/shared/markdown-editor/markdown-wysiwyg.js';

function dom(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

/** Markdown after going through the formatted editor. */
function roundTrip(markdown: string): string {
  return editorToMarkdown(dom(markdownToEditorHtml(markdown)));
}

describe('markdownToEditorHtml', () => {
  it('shows an empty document as an empty paragraph', () => {
    expect(markdownToEditorHtml('')).toBe('<p><br></p>');
  });

  it('renders headings, paragraphs, rules and quotes', () => {
    const html = markdownToEditorHtml('# Title\n\nText\n\n---\n\n> one\n> two');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<p>Text</p>');
    expect(html).toContain('<hr>');
    expect(html).toContain('<blockquote><p>one</p><p>two</p></blockquote>');
  });

  it('renders inline formatting, links and code', () => {
    const html = markdownToEditorHtml(
      '**bold** *it* _it2_ ~~gone~~ `a<b` ***both*** [site](https://x.dev) [bad](javascript:alert(1))',
    );
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>it</em>');
    expect(html).toContain('<em>it2</em>');
    expect(html).toContain('<del>gone</del>');
    expect(html).toContain('<code>a&lt;b</code>');
    expect(html).toContain('<strong><em>both</em></strong>');
    expect(html).toContain('<a href="https://x.dev"');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('bad');
  });

  it('keeps nested emphasis and inline HTML, and drops unsafe markup', () => {
    const html = markdownToEditorHtml(
      '**a `b`**\n\n<mark>hl</mark> <span style="color: #ff0000">red</span> <script>x</script>',
    );
    expect(html).toContain('<strong>a ');
    expect(html).toContain('<mark>hl</mark>');
    expect(html).toContain('style="color: #ff0000"');
    expect(html).not.toContain('<script');
  });

  it('renders images from safe sources only', () => {
    const html = markdownToEditorHtml(
      '![shot](/attachments/files/abc "t")\n\n![evil](http://x.dev/a.png)',
    );
    expect(html).toContain('<img src="/attachments/files/abc" alt="shot">');
    expect(html).not.toContain('http://x.dev');
    expect(html).toContain('evil');
  });

  it('turns wikilinks into atoms that keep their Markdown', () => {
    const html = markdownToEditorHtml('See [[Other Doc]] and [[Target|Label]]');
    expect(html).toContain('data-md-raw="[[Other Doc]]"');
    expect(html).toContain('>Label</span>');
    expect(html).toContain('contenteditable="false"');
  });

  it('renders code blocks', () => {
    expect(markdownToEditorHtml('```ts\nconst a = <b>;\n```')).toBe(
      '<pre data-lang="ts"><code>const a = &lt;b&gt;;</code></pre>',
    );
  });

  it('renders raw HTML blocks as atoms', () => {
    const html = markdownToEditorHtml('<div class="x">hi <script>1</script></div>');
    expect(html).toContain('contenteditable="false"');
    expect(html).toContain('data-md-raw="&lt;div');
    expect(html).not.toContain('<script');
  });

  it('renders tables with alignments and pads short rows', () => {
    const html = markdownToEditorHtml('| a | b |\n| :---: | ---: |\n| 1 |');
    expect(html).toContain('<th data-align="center">a</th>');
    expect(html).toContain('<th data-align="right">b</th>');
    expect(html).toContain('<td data-align="center">1</td><td data-align="right"></td>');
  });

  it('renders nested and task lists', () => {
    const html = markdownToEditorHtml(
      '- a\n  - b\n    - c\n- d\n\n1. one\n2. two\n\n- [ ] todo\n- [x] done',
    );
    expect(html).toContain('<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>');
    expect(html).toContain('<ol><li>one</li><li>two</li></ol>');
    expect(html).toContain('<li><input type="checkbox"> todo</li>');
    expect(html).toContain('<li><input type="checkbox" checked> done</li>');
  });

  it('closes the levels of a list that ends inside a nested one', () => {
    expect(markdownToEditorHtml('- a' + String.fromCharCode(10) + '  - b')).toBe(
      '<ul><li>a<ul><li>b</li></ul></li></ul>',
    );
  });

  it('aligns the columns a separator row does not describe to the left', () => {
    expect(
      markdownToEditorHtml(['| a | b |', '| --- |', '| 1 | 2 |'].join(String.fromCharCode(10))),
    ).toContain('<th data-align="left">b</th>');
  });

  it('keeps list levels when a list climbs back out of a nested one', () => {
    const html = markdownToEditorHtml('- a\n    - deep\n  - mid\n- b');
    expect(html).toContain('</ul></li>');
    expect(html.match(/<li>/g)).toHaveLength(4);
  });
});

describe('editorToMarkdown', () => {
  it.each([
    ['# Title\n\nSome text'],
    ['## Two\n\n### Three\n\n#### Four'],
    ['**bold** and *italic* and ~~strike~~ and `code`'],
    ['[site](https://x.dev) and ![shot](/attachments/files/abc)'],
    ['- a\n  - b\n- c'],
    ['1. one\n2. two'],
    ['- [ ] todo\n- [x] done'],
    ['> quoted\n>\n> second'],
    ['```ts\nconst a = 1;\n\nconst b = 2;\n```'],
    ['| a | b |\n| :---: | ---: |\n| 1 | 2 |'],
    ['---'],
    ['See [[Other Doc]] and [[Target|Label]] here'],
    ['<div>\n  <b>raw</b>\n</div>'],
    ['<mark>highlight</mark> and <u>under</u> and <span style="color: #ff0000">red</span>'],
    ['***both***'],
  ])('keeps %j through the editor', (markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it('normalizes other bullet markers and setext headings', () => {
    expect(roundTrip('* a\n* b')).toBe('- a\n- b');
    expect(roundTrip('Title\n=====')).toBe('# Title');
  });

  it('writes the HTML browsers produce while typing', () => {
    expect(editorToMarkdown(dom('plain <b>bold</b> text'))).toBe('plain **bold** text');
    expect(editorToMarkdown(dom('<div>one</div><div>two<br></div><div><br></div>'))).toBe(
      'one\n\ntwo',
    );
    expect(editorToMarkdown(dom('<p>a<br>b</p>'))).toBe('a<br>b');
    expect(editorToMarkdown(dom('<p><br></p>'))).toBe('');
    expect(editorToMarkdown(dom('<p>a\n   b&nbsp;c​</p>'))).toBe('a b c');
  });

  it('keeps the spaces outside the emphasis markers', () => {
    expect(editorToMarkdown(dom('<p>a<strong> b </strong>c</p>'))).toBe('a **b** c');
    expect(editorToMarkdown(dom('<p><em> </em>x</p>'))).toBe('x');
  });

  it('uses HTML tags when emphasis has formatting inside', () => {
    expect(editorToMarkdown(dom('<p><strong>a <em>b</em> c</strong></p>'))).toBe(
      '<strong>a *b* c</strong>',
    );
    expect(editorToMarkdown(dom('<p><em><strong>x</strong></em></p>'))).toBe('***x***');
    // Same kind inside itself is not a combination: the inner one is written as it is.
    expect(editorToMarkdown(dom('<p><strong><strong>x</strong></strong></p>'))).toBe(
      '<strong>**x**</strong>',
    );
    expect(editorToMarkdown(dom('<p><del><a href="/x">l</a></del></p>'))).toBe(
      '<del>[l](/x)</del>',
    );
    expect(editorToMarkdown(dom('<p><i><s>x</s></i></p>'))).toBe('<em>~~x~~</em>');
    expect(editorToMarkdown(dom('<p><strike>x</strike></p>'))).toBe('~~x~~');
    expect(editorToMarkdown(dom('<p><strong><em>x <code>y</code></em></strong></p>'))).toBe(
      '<strong><em>x `y`</em></strong>',
    );
  });

  it('reads colours and highlights from styled spans and fonts', () => {
    expect(editorToMarkdown(dom('<p><span style="color: rgb(255, 0, 0)">red</span></p>'))).toBe(
      '<span style="color: #ff0000">red</span>',
    );
    expect(editorToMarkdown(dom('<p><font color="#0F0">g</font></p>'))).toBe(
      '<span style="color: #0f0">g</span>',
    );
    expect(
      editorToMarkdown(dom('<p><span style="background-color: rgb(250, 204, 21)">y</span></p>')),
    ).toBe('<mark>y</mark>');
    expect(
      editorToMarkdown(dom('<p><span style="background-color: transparent">t</span></p>')),
    ).toBe('t');
    expect(
      editorToMarkdown(dom('<p><span style="background-color: rgba(0, 0, 0, 0)">t</span></p>')),
    ).toBe('t');
    expect(editorToMarkdown(dom('<p><span style="color: bogus">c</span></p>'))).toBe('c');
    expect(editorToMarkdown(dom('<p><span>plain</span></p>'))).toBe('plain');
  });

  it('writes sub, sup, kbd and links without an address as text', () => {
    expect(editorToMarkdown(dom('<p>x<sup>2</sup> <kbd>k</kbd> <small>s</small></p>'))).toBe(
      'x<sup>2</sup> <kbd>k</kbd> <small>s</small>',
    );
    expect(editorToMarkdown(dom('<p><a>text</a></p>'))).toBe('text');
  });

  it('writes images with the original address kept by the editor', () => {
    expect(
      editorToMarkdown(
        dom('<p><img src="blob:x" data-adk-src="/attachments/drafts/1" alt="shot"></p>'),
      ),
    ).toBe('![shot](/attachments/drafts/1)');
    expect(editorToMarkdown(dom('<p><img src="/attachments/files/a"></p>'))).toBe(
      '![](/attachments/files/a)',
    );
    expect(editorToMarkdown(dom('<p><img></p>'))).toBe('');
  });

  it('ignores comments, checkboxes outside lists and unknown wrappers', () => {
    expect(editorToMarkdown(dom('<!-- c --><p>a</p>'))).toBe('a');
    expect(editorToMarkdown(dom('<p><input type="checkbox">a</p>'))).toBe('a');
    expect(editorToMarkdown(dom('<section>kept</section>'))).toBe('kept');
  });

  it('writes lists the browser creates', () => {
    expect(
      editorToMarkdown(
        dom('<ul><li>a<ul><li>b</li></ul></li><li><p>c</p></li><span>x</span></ul>'),
      ),
    ).toBe('- a\n  - b\n- c');
    const list = dom('<ul><li><input type="checkbox">&nbsp;todo</li></ul>');
    expect(editorToMarkdown(list)).toBe('- [ ] todo');
    list.querySelector('input')!.checked = true;
    expect(editorToMarkdown(list)).toBe('- [x] todo');
  });

  it('writes code blocks that browsers fill with <br> and <div>', () => {
    expect(editorToMarkdown(dom('<pre>a<br>b<div>c</div><div>d</div>\n</pre>'))).toBe(
      '```\na\nb\nc\nd\n```',
    );
    expect(editorToMarkdown(dom('<pre>​</pre><p>after</p>'))).toBe('after');
    expect(editorToMarkdown(dom('<pre data-lang="js"><code>x</code><!-- c --></pre>'))).toBe(
      '```js\nx\n```',
    );
  });

  it('writes tables the browser creates, filling missing cells', () => {
    expect(
      editorToMarkdown(
        dom(
          '<table><tbody><tr><th>a</th><th>b</th></tr><tr><td>1</td></tr><tr><td>x<br>y</td><td>2</td><td>extra</td></tr></tbody></table>',
        ),
      ),
    ).toBe('| a | b |\n| --- | --- |\n| 1 |  |\n| x<br>y | 2 |');
    expect(editorToMarkdown(dom('<table></table><p>after</p>'))).toBe('after');
  });

  it('writes quotes that hold several blocks', () => {
    expect(
      editorToMarkdown(dom('<blockquote><p>a</p><p>b</p><ul><li>c</li></ul></blockquote>')),
    ).toBe('> a\n>\n> b\n>\n> - c');
  });
});

describe('outline', () => {
  const markdown =
    '# One\n\ntext\n\n## **Two** [link](/x)\n\n```\n# not a heading\n```\n\n### Three';

  it('lists the headings of a document', () => {
    expect(markdownOutline(markdown)).toEqual([
      { level: 1, text: 'One' },
      { level: 2, text: 'Two link' },
      { level: 3, text: 'Three' },
    ]);
    expect(markdownOutline('just text')).toEqual([]);
  });

  it('finds where each heading starts in the source', () => {
    const headings = markdownOutline(markdown);
    const offsets = outlineOffsets(markdown, headings);
    expect(offsets).toEqual([0, markdown.indexOf('## '), markdown.indexOf('### ')]);
    expect(outlineOffsets('Title\n=====', markdownOutline('Title\n=====')).length).toBe(1);
  });

  it('falls back to the start when a heading cannot be located', () => {
    expect(outlineOffsets('nothing here', [{ level: 1, text: 'Missing' }])).toEqual([0]);
  });
});
