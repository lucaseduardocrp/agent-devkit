import { render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrainView } from '../src/features/brain/BrainView.js';
import {
  clearPassageHighlight,
  highlightPassage,
} from '../src/features/shared/highlight-passage.js';
import type { ReferenceFocus } from '../src/features/shared/reference-focus.js';
import { ApiClient } from '../src/lib/api-client.js';

/** A stand-in for the browser's CSS Custom Highlight API, which jsdom does not have. */
function stubHighlights() {
  const set = vi.fn();
  const remove = vi.fn();
  class FakeHighlight {
    public readonly ranges: Range[];
    public constructor(...ranges: Range[]) {
      this.ranges = ranges;
    }
  }
  vi.stubGlobal('CSS', { highlights: { set, delete: remove } });
  vi.stubGlobal('Highlight', FakeHighlight);
  return { set, remove };
}

afterEach(() => vi.unstubAllGlobals());

describe('highlightPassage', () => {
  const page = () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<h2>Rules</h2><p>The <b>manager</b> approves,</p><p>or rejects the <a href="/x">request</a>.</p><script>hidden()</script>';
    document.body.append(root);
    return root;
  };

  it('highlights the passage across elements, ignoring markdown marks and spacing', () => {
    const { set } = stubHighlights();
    const root = page();
    root.querySelector('p')!.scrollIntoView = vi.fn();
    expect(
      highlightPassage(root, '**The manager** approves,\n\nor rejects the [request](/x).'),
    ).toBe(true);
    expect(set).toHaveBeenCalledWith('adk-passage', expect.anything());
    const [, highlight] = set.mock.calls[0] as [string, { ranges: Range[] }];
    expect(highlight.ranges[0]!.toString()).toBe('The manager approves,or rejects the request');
    expect(root.querySelector('p')!.scrollIntoView).toHaveBeenCalledWith({
      block: 'center',
      behavior: 'smooth',
    });
  });

  it('falls back to the start of a long passage whose end changed', () => {
    const { set } = stubHighlights();
    const root = document.createElement('div');
    const text = 'The manager approves or rejects the request. '.repeat(6);
    root.textContent = `${text.slice(0, 200)} but the page changed from here.`;
    document.body.append(root);
    expect(highlightPassage(root, text)).toBe(true);
    const [, highlight] = set.mock.calls[0] as [string, { ranges: Range[] }];
    expect(highlight.ranges[0]!.toString().length).toBeGreaterThan(100);
  });

  it('says when the passage is not on the page, and never reads scripts', () => {
    stubHighlights();
    const root = page();
    expect(highlightPassage(root, 'Never written here')).toBe(false);
    expect(highlightPassage(root, 'hidden()')).toBe(false);
    expect(highlightPassage(root, '**')).toBe(false);
  });

  it('still scrolls to the passage when the browser cannot highlight it', () => {
    const root = page();
    const scroll = vi.fn();
    root.querySelector('p')!.scrollIntoView = scroll;
    expect(highlightPassage(root, 'The manager approves')).toBe(true);
    expect(scroll).toHaveBeenCalled();
    expect(() => clearPassageHighlight()).not.toThrow();
  });

  it('removes the highlight', () => {
    const { remove } = stubHighlights();
    clearPassageHighlight();
    expect(remove).toHaveBeenCalledWith('adk-passage');
  });
});

describe('Brain opened from a reference', () => {
  const doc = (id: string, title: string, content: string) => ({
    id,
    pageId: id,
    source: `app://${id}`,
    title,
    content,
    chunksCount: 1,
    totalCharacters: content.length,
    updatedAt: 'now',
    isCustom: true,
  });
  const first = doc('page-1', 'First page', '# First page\n\nNothing to see.');
  const second = doc(
    'page-2',
    'Approval of events',
    '# Approval of events\n\nIntro text.\n\nThe manager **approves** or rejects the request.\n\nClosing text.',
  );

  function client() {
    const api = new ApiClient();
    vi.spyOn(api, 'getKnowledgeStats').mockResolvedValue({ documentsCount: 2, chunksCount: 2 });
    vi.spyOn(api, 'getKnowledgeDocuments').mockResolvedValue([first, second]);
    vi.spyOn(api, 'getKnowledgeRelations').mockResolvedValue([]);
    vi.spyOn(api, 'getDocumentAttachments').mockResolvedValue([]);
    return api;
  }

  const focus = (changes: Partial<ReferenceFocus> = {}): ReferenceFocus => ({
    kind: 'brain',
    ref: 'page-2',
    nonce: 1,
    ...changes,
  });

  it('opens the page in its own tab and highlights the passage that was attached', async () => {
    const { set } = stubHighlights();
    const onFocusHandled = vi.fn();
    const view = render(
      <BrainView
        apiClient={client()}
        initialDocuments={[first, second]}
        focus={focus({ excerpt: 'The manager **approves** or rejects the request.' })}
        onFocusHandled={onFocusHandled}
      />,
    );
    await waitFor(() => expect(onFocusHandled).toHaveBeenCalledTimes(1));
    // The page opens in a tab, as when it is clicked in the list: its text is on screen.
    expect(await view.findByText('Closing text.')).toBeTruthy();
    await waitFor(() => expect(set).toHaveBeenCalledWith('adk-passage', expect.anything()));
    const [, highlight] = set.mock.calls.at(-1) as [string, { ranges: Range[] }];
    expect(highlight.ranges[0]!.toString()).toContain(
      'The manager approves or rejects the request',
    );
  });

  it('opens the page without highlighting when no passage came with it', async () => {
    const { set } = stubHighlights();
    const onFocusHandled = vi.fn();
    const view = render(
      <BrainView
        apiClient={client()}
        initialDocuments={[first, second]}
        focus={focus()}
        onFocusHandled={onFocusHandled}
      />,
    );
    await waitFor(() => expect(onFocusHandled).toHaveBeenCalled());
    expect(await view.findByText('Closing text.')).toBeTruthy();
    expect(set).not.toHaveBeenCalled();
  });

  it('opens a request once, and ignores one meant for another module', async () => {
    const onFocusHandled = vi.fn();
    const api = client();
    const view = render(
      <BrainView
        apiClient={api}
        initialDocuments={[first, second]}
        focus={focus({ kind: 'spec' })}
        onFocusHandled={onFocusHandled}
      />,
    );
    await view.findAllByText('First page');
    expect(onFocusHandled).not.toHaveBeenCalled();
    view.rerender(
      <BrainView
        apiClient={api}
        initialDocuments={[first, second]}
        focus={focus({ nonce: 2 })}
        onFocusHandled={onFocusHandled}
      />,
    );
    await waitFor(() => expect(onFocusHandled).toHaveBeenCalledTimes(1));
    view.rerender(
      <BrainView
        apiClient={api}
        initialDocuments={[first, second]}
        focus={focus({ nonce: 2 })}
        onFocusHandled={onFocusHandled}
      />,
    );
    expect(onFocusHandled).toHaveBeenCalledTimes(1);
  });

  it('waits for a page that is not in the list yet', async () => {
    const onFocusHandled = vi.fn();
    const api = client();
    const view = render(
      <BrainView
        apiClient={api}
        initialDocuments={[first]}
        focus={focus()}
        onFocusHandled={onFocusHandled}
      />,
    );
    expect(onFocusHandled).not.toHaveBeenCalled();
    view.rerender(
      <BrainView
        apiClient={api}
        initialDocuments={[first, second]}
        focus={focus()}
        onFocusHandled={onFocusHandled}
      />,
    );
    // The list the view loads on its own is what brings the page in.
    await waitFor(() => expect(onFocusHandled).toHaveBeenCalledTimes(1));
  });
});
