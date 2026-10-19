import React, { useState } from 'react';
import { cn } from '../../lib/utils.js';
import { Button } from '../../components/ui/button.js';
import { parseMarkdownBlocks, renderInlineContent } from './markdown-parser.js';
import { useActivityRunner } from '../activities/ActivityCenter.js';
import { useI18n } from '../../lib/i18n/index.js';
import { MermaidDiagram, RenderedCode } from './RenderedCode.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { INLINE_HTML_TAG, sanitizeHtml } from '../../lib/sanitize-html.js';

const htmlContentClass =
  'break-words leading-relaxed text-[#cfcfcf] [&_a]:text-[#4a8fe8] hover:[&_a]:underline [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-[#4a8fe8] [&_blockquote]:pl-4 [&_code]:rounded [&_code]:bg-[#222226] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs [&_code]:text-[#9fc4ff] [&_del]:line-through [&_em]:italic [&_h1]:my-3 [&_h1]:text-2xl [&_h1]:font-bold [&_h2]:my-3 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:my-2 [&_h3]:text-lg [&_h3]:font-semibold [&_h4]:my-2 [&_h4]:font-semibold [&_hr]:my-4 [&_hr]:border-[#26262a] [&_kbd]:rounded [&_kbd]:border [&_kbd]:border-[#3a3a3e] [&_kbd]:px-1 [&_kbd]:font-mono [&_kbd]:text-xs [&_li]:my-1 [&_mark]:bg-yellow-500/30 [&_mark]:text-inherit [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-2 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-[#111113] [&_pre]:p-3 [&_strong]:font-semibold [&_strong]:text-[#f5f5f5] [&_summary]:cursor-pointer [&_summary]:font-semibold [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-[#26262a] [&_td]:px-3 [&_td]:py-1.5 [&_th]:border [&_th]:border-[#26262a] [&_th]:bg-[#1c1c1f] [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_u]:underline [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6';

const inlineHtmlClass =
  '[&_a]:text-[#4a8fe8] hover:[&_a]:underline [&_code]:rounded [&_code]:bg-[#222226] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs [&_code]:text-[#9fc4ff] [&_del]:line-through [&_em]:italic [&_kbd]:rounded [&_kbd]:border [&_kbd]:border-[#3a3a3e] [&_kbd]:px-1 [&_kbd]:font-mono [&_kbd]:text-xs [&_mark]:bg-yellow-500/30 [&_mark]:text-inherit [&_strong]:font-semibold [&_u]:underline';

const INLINE_CODE_SPAN = /(`[^`]+`)/;
const INLINE_HTML_TAGS = new RegExp(INLINE_HTML_TAG.source, 'gi');

/** Mixes inline HTML tags with inline Markdown by shielding the tags from React escaping. */
function renderMixedInline(
  text: string,
  renderMarkdown: (value: string) => React.ReactNode[],
): React.ReactNode[] | React.JSX.Element {
  const parts = text.split(INLINE_CODE_SPAN);
  if (!parts.some((part, index) => index % 2 === 0 && INLINE_HTML_TAG.test(part))) {
    return renderMarkdown(text);
  }
  const tags: string[] = [];
  const shielded = parts
    .map((part, index) =>
      index % 2 === 0 ? part.replace(INLINE_HTML_TAGS, (tag) => `${tags.push(tag) - 1}`) : part,
    )
    .join('');
  const markup = renderToStaticMarkup(<>{renderMarkdown(shielded)}</>).replace(
    /(\d+)/g,
    (_, index: string) => tags[Number(index)]!,
  );
  return (
    <span className={inlineHtmlClass} dangerouslySetInnerHTML={{ __html: sanitizeHtml(markup) }} />
  );
}

export interface MarkdownViewerProps {
  readonly content: string;
  readonly className?: string;
  readonly showModeToggle?: boolean;
  readonly documentTitle?: string;
  readonly sourceUrl?: string;
  readonly onWikilinkClick?: (target: string) => void;
}

export function MarkdownViewer({
  content,
  className,
  showModeToggle = true,
  documentTitle,
  sourceUrl,
  onWikilinkClick,
}: MarkdownViewerProps): React.JSX.Element {
  const [mode, setMode] = useState<'preview' | 'raw'>('preview');
  const [exported, setExported] = useState(false);
  const [copiedCodeId, setCopiedCodeId] = useState<string | null>(null);
  const { runActivity } = useActivityRunner();
  const { t } = useI18n();

  const handleExportMd = async () => {
    try {
      const cleanTitle = documentTitle
        ?.trim()
        .replace(/[/\\?%*:|"<>]/g, '-')
        .replace(/\s+/g, ' ');
      const fileName = cleanTitle
        ? cleanTitle.toLowerCase().endsWith('.md')
          ? cleanTitle
          : `${cleanTitle}.md`
        : 'documento.md';
      await runActivity({ kind: 'download', title: `Baixando “${fileName}”` }, () => {
        const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        return Promise.resolve();
      });
      setExported(true);
      setTimeout(() => setExported(false), 2000);
    } catch {
      // export fallback
    }
  };

  const handleCopyBlock = async (code: string, id: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCodeId(id);
      setTimeout(() => setCopiedCodeId(null), 2000);
    } catch {
      // clipboard fallback
    }
  };

  const blocks = parseMarkdownBlocks(content);
  const normalizedDocTitle = documentTitle?.trim().toLowerCase();
  const renderInline = (text: string) =>
    renderMixedInline(text, (value) =>
      renderInlineContent(value, onWikilinkClick, (target) => t('brain.internalLink', { target })),
    );

  const displayBlocks =
    normalizedDocTitle &&
    blocks.length > 0 &&
    blocks[0]?.type === 'heading' &&
    blocks[0].level === 1 &&
    blocks[0].text.trim().toLowerCase() === normalizedDocTitle
      ? blocks.slice(1)
      : blocks;

  return (
    <div className={cn('space-y-4', className)} data-testid="markdown-viewer">
      {/* Top Toolbar / Mode Toggle */}
      {showModeToggle && (
        <div className="flex items-center justify-between border-b border-[#262628] pb-3 text-xs text-[#a0a0a0]">
          <div className="flex items-center gap-1 rounded-md border border-[#2a2a2e] bg-[#1a1a1d] p-0.5">
            <Button
              type="button"
              variant={mode === 'preview' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setMode('preview')}
              data-testid="btn-markdown-preview"
              className={cn(
                'h-7 px-2.5 text-xs',
                mode === 'preview' && 'bg-[#26262a] text-white shadow-sm',
              )}
              leftIcon={<i className="ti ti-eye text-xs" aria-hidden="true" />}
            >
              {t('brain.formatted')}
            </Button>
            <Button
              type="button"
              variant={mode === 'raw' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setMode('raw')}
              data-testid="btn-markdown-raw"
              className={cn(
                'h-7 px-2.5 text-xs',
                mode === 'raw' && 'bg-[#26262a] text-white shadow-sm',
              )}
              leftIcon={<i className="ti ti-code text-xs" aria-hidden="true" />}
            >
              {t('brain.rawMarkdown')}
            </Button>
          </div>

          <div className="flex items-center gap-2">
            {sourceUrl && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => window.open(sourceUrl, '_blank', 'noopener,noreferrer')}
                data-testid="btn-open-source"
                title={t('brain.openSource')}
                className="h-8 px-2.5 text-xs"
                leftIcon={<i className="ti ti-external-link text-xs" aria-hidden="true" />}
              >
                {t('brain.openSource')}
              </Button>
            )}

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void handleExportMd()}
              data-testid="btn-export-markdown"
              title={t('brain.exportMarkdown')}
              className="h-8 px-2.5 text-xs"
              leftIcon={
                <i
                  className={cn('ti text-xs', exported ? 'ti-check text-green-400' : 'ti-download')}
                  aria-hidden="true"
                />
              }
            >
              {exported ? t('brain.exported') : t('brain.exportMarkdown')}
            </Button>
          </div>
        </div>
      )}

      {/* Raw Markdown Source View */}
      {mode === 'raw' ? (
        <div
          className="relative overflow-hidden rounded-lg border border-[#26262a] bg-[#131315]"
          data-testid="markdown-raw-view"
        >
          <pre className="thin-scrollbar overflow-x-auto p-4 font-mono text-xs leading-relaxed text-[#dcdcdc] whitespace-pre-wrap select-text">
            <code>{content}</code>
          </pre>
        </div>
      ) : (
        /* Rendered Markdown Preview */
        <div
          className="space-y-4 text-[15px] leading-relaxed text-[#dcdcdc]"
          data-testid="markdown-preview-view"
        >
          {displayBlocks.length === 0 ? (
            <p className="text-sm italic text-[#707070]">{t('brain.noAdditionalContent')}</p>
          ) : (
            displayBlocks.map((block, idx) => {
              const blockKey = `block-${idx}`;

              switch (block.type) {
                case 'heading': {
                  const headingClasses = {
                    1: 'text-2xl sm:text-3xl font-bold tracking-tight text-[#f5f5f5] pt-4 pb-1 border-b border-[#28282c]',
                    2: 'text-xl sm:text-2xl font-semibold tracking-tight text-[#ececec] pt-3 pb-1 border-b border-[#242428]',
                    3: 'text-lg sm:text-xl font-semibold text-[#e0e0e0] pt-2',
                    4: 'text-base font-semibold text-[#d5d5d5]',
                    5: 'text-sm font-semibold uppercase tracking-wider text-[#a8a8a8]',
                    6: 'text-xs font-semibold uppercase tracking-wider text-[#888888]',
                  }[block.level];

                  const HeadingTag = `h${block.level}` as keyof React.JSX.IntrinsicElements;
                  return (
                    <HeadingTag key={blockKey} className={headingClasses}>
                      {renderInline(block.text)}
                    </HeadingTag>
                  );
                }

                case 'code': {
                  const isMermaid = ['mermaid', 'mmd'].includes(block.language.toLowerCase());
                  const isDiagramOrPlain = !block.language;

                  return (
                    <div
                      key={blockKey}
                      className="my-3 overflow-hidden rounded-md border border-[#28282c] bg-[#111113]"
                      data-testid={`code-block-${idx}`}
                    >
                      <div className="flex items-center justify-between border-b border-[#202024] bg-[#18181b] px-3 py-1.5 text-xs text-[#8e8e93]">
                        <span className="flex items-center gap-1.5 font-mono text-xs">
                          {isMermaid ? (
                            <>
                              <i className="ti ti-chart-dots text-sm text-[#60a5fa]" />
                              <span className="text-[#60a5fa]">mermaid</span>
                            </>
                          ) : isDiagramOrPlain ? (
                            <>
                              <i className="ti ti-hierarchy-2 text-sm text-[#a0a0a0]" />
                              <span>{t('brain.diagramFlow')}</span>
                            </>
                          ) : (
                            <span>{block.language}</span>
                          )}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => void handleCopyBlock(block.code, blockKey)}
                          title={t('brain.copyCode')}
                          className="h-6 gap-1 px-1.5 text-xs text-[#a0a0a0] hover:text-white"
                          leftIcon={
                            <i
                              className={cn(
                                'ti text-xs',
                                copiedCodeId === blockKey ? 'ti-check text-green-400' : 'ti-copy',
                              )}
                              aria-hidden="true"
                            />
                          }
                        >
                          {copiedCodeId === blockKey ? t('brain.copied') : t('common.copy')}
                        </Button>
                      </div>
                      {isMermaid && <MermaidDiagram code={block.code} />}
                      <RenderedCode code={block.code} language={block.language} />
                    </div>
                  );
                }

                case 'table':
                  return (
                    <div
                      key={blockKey}
                      className="thin-scrollbar my-4 overflow-x-auto rounded-md border border-[#26262a]"
                      data-testid={`table-block-${idx}`}
                    >
                      <table className="w-full border-collapse text-left text-xs sm:text-sm">
                        <thead>
                          <tr className="border-b border-[#28282c] bg-[#1c1c1f]">
                            {block.headers.map((h, hIdx) => (
                              <th
                                key={`th-${hIdx}`}
                                style={{ textAlign: block.alignments[hIdx] }}
                                className="border-r border-[#26262a] px-3.5 py-2.5 font-semibold text-[#f0f0f0] last:border-r-0"
                              >
                                {renderInline(h)}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {block.rows.map((row, rIdx) => (
                            <tr
                              key={`tr-${rIdx}`}
                              className="border-b border-[#222225] transition-colors odd:bg-[#141416] even:bg-[#18181b] hover:bg-[#202024] last:border-b-0"
                            >
                              {row.map((cell, cIdx) => (
                                <td
                                  key={`td-${cIdx}`}
                                  style={{ textAlign: block.alignments[cIdx] }}
                                  className="border-r border-[#222225] px-3.5 py-2 text-[#cccccc] last:border-r-0"
                                >
                                  {renderInline(cell)}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );

                case 'blockquote':
                  return (
                    <blockquote
                      key={blockKey}
                      className="my-3 border-l-3 border-[#4a8fe8] bg-[#161a22]/50 py-2 pl-4 pr-3 text-[#c0c0c8] italic"
                    >
                      {block.text.split('\n').map((line, lIdx) => (
                        <p key={`quote-line-${lIdx}`} className="leading-relaxed">
                          {renderInline(line)}
                        </p>
                      ))}
                    </blockquote>
                  );

                case 'list': {
                  const ListTag = block.ordered ? 'ol' : 'ul';
                  return (
                    <ListTag
                      key={blockKey}
                      className={cn(
                        'my-2.5 space-y-1.5 pl-5',
                        block.ordered ? 'list-decimal' : 'list-disc',
                      )}
                    >
                      {block.items.map((it, itIdx) => (
                        <li
                          key={`item-${itIdx}`}
                          style={{ marginLeft: `${Math.min(it.indent * 8, 32)}px` }}
                          className="text-[#d0d0d0]"
                        >
                          {it.checked !== undefined ? (
                            <span className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={it.checked}
                                readOnly
                                className="accent-[#4a8fe8]"
                                aria-label={t('brain.listCheckbox')}
                              />
                              <span>{renderInline(it.text)}</span>
                            </span>
                          ) : (
                            renderInline(it.text)
                          )}
                        </li>
                      ))}
                    </ListTag>
                  );
                }

                case 'hr':
                  return <hr key={blockKey} className="my-6 border-t border-[#26262a]" />;

                case 'html':
                  return (
                    <div
                      key={blockKey}
                      className={cn('thin-scrollbar overflow-x-auto', htmlContentClass)}
                      data-testid={`html-block-${idx}`}
                      dangerouslySetInnerHTML={{ __html: sanitizeHtml(block.html) }}
                    />
                  );

                case 'paragraph':
                  return (
                    <p key={blockKey} className="leading-relaxed text-[#cfcfcf]">
                      {renderInline(block.text)}
                    </p>
                  );
              }
            })
          )}
        </div>
      )}
    </div>
  );
}
