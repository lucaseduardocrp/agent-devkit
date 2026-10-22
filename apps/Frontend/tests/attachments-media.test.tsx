import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkdownViewer } from '../src/features/brain/MarkdownViewer.js';
import { AttachmentPanel } from '../src/features/shared/AttachmentPanel.js';
import {
  MediaProvider,
  createDraft,
  discardDrafts,
  editorHtml,
  isSafeImageSource,
  resolveInlineImages,
  resolveMedia,
  saveWithDrafts,
} from '../src/features/shared/media.js';
import { sanitizeRichText } from '../src/features/testplans/test-case-fields.js';
import { ApiClient } from '../src/lib/api-client.js';
import { sanitizeHtml } from '../src/lib/sanitize-html.js';

const FILE = '/attachments/files/0f8fad5b-d9cb-469f-a165-70867728950e';

function client(blob = new Blob(['png'], { type: 'image/png' })) {
  const apiClient = new ApiClient({ baseUrl: 'http://api.test' });
  const getMedia = vi.spyOn(apiClient, 'getMedia').mockResolvedValue(blob);
  return { apiClient, getMedia };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('image sources', () => {
  it('accepts HTTPS links and ADK files only', () => {
    expect(isSafeImageSource(FILE)).toBe(true);
    expect(isSafeImageSource('https://dev.azure.com/org/_apis/wit/attachments/1')).toBe(true);
    expect(isSafeImageSource('http://example.com/a.png')).toBe(false);
    expect(isSafeImageSource('javascript:alert(1)')).toBe(false);
    expect(isSafeImageSource('/attachments/files/../../etc')).toBe(false);
  });

  it('keeps safe images in sanitized HTML and rich text', () => {
    expect(sanitizeHtml(`<img src="${FILE}" alt="a" onerror="x()">`)).toBe(
      `<img src="${FILE}" alt="a">`,
    );
    expect(sanitizeHtml('<img src="javascript:alert(1)">')).toBe('');
    expect(
      sanitizeRichText(`<p>Step</p><img onerror=x() src='${FILE}' alt="shot"><img src=http://a/b>`),
    ).toBe(`<p>Step</p><img src="${FILE}" alt="shot">`);
  });
});

describe('inline images', () => {
  it('loads ADK files with the session and saves their original address', async () => {
    const { apiClient, getMedia } = client();
    const root = document.createElement('div');
    root.innerHTML = `<p><img src="${FILE}" alt="a"></p>`;
    resolveInlineImages(root, apiClient);
    await waitFor(() => expect(root.querySelector('img')!.src).toMatch(/^blob:/));
    expect(getMedia).toHaveBeenCalledWith(FILE);
    const saved = editorHtml(root);
    expect(saved).toContain(`src="${FILE}"`);
    expect(saved).not.toMatch(/blob:|data-adk|loading=/);
  });

  it('renders Markdown images through the media provider', async () => {
    const { apiClient } = client();
    render(
      <MediaProvider apiClient={apiClient}>
        <MarkdownViewer content={`Antes ![Fluxo](${FILE}) depois`} showModeToggle={false} />
      </MediaProvider>,
    );
    const image = await screen.findByRole('img', { name: 'Fluxo' });
    await waitFor(() => expect(image.getAttribute('src')).toMatch(/^blob:/));
  });
});

describe('AttachmentPanel', () => {
  it('lists images, videos and documents of an item', async () => {
    const { apiClient } = client();
    render(
      <MediaProvider apiClient={apiClient}>
        <AttachmentPanel
          scope="pbi"
          attachments={[
            { id: '1', name: 'print.png', kind: 'image', scope: 'pbi', source: 'adk', url: FILE },
            {
              id: '2',
              name: 'repro.mp4',
              kind: 'video',
              size: 2 * 1024 * 1024,
              scope: 'pbi',
              source: 'adk',
              url: FILE.replace('0f8f', '1f8f'),
            },
            {
              id: 'provider:3',
              name: 'logs.pdf',
              kind: 'document',
              scope: 'pbi',
              source: 'url',
              url: 'https://dev.azure.com/org/_apis/wit/attachments/3?fileName=logs.pdf',
            },
          ]}
        />
      </MediaProvider>,
    );
    expect(await screen.findByRole('img', { name: 'print.png' })).toBeTruthy();
    expect(await screen.findByLabelText('repro.mp4')).toBeTruthy();
    expect(screen.getByText('logs.pdf')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Remove|Remover/ })).toBeNull();
  });
});

describe('drafts', () => {
  const png = () => new File(['png'], 'shot.png', { type: 'image/png' });

  it('keeps pasted files in the browser and uploads only what the saved item references', async () => {
    const { apiClient } = client();
    const upload = vi.spyOn(apiClient, 'uploadAttachment').mockImplementation((scope, file) =>
      Promise.resolve({
        id: '0f8fad5b-d9cb-469f-a165-70867728950e',
        name: file.name,
        kind: 'image',
        scope,
        source: 'adk',
        url: FILE,
      }),
    );
    const inText = createDraft('issue', png());
    const removed = createDraft('issue', png());
    expect(inText.url).toMatch(/^\/attachments\/drafts\//);
    await expect(resolveMedia(apiClient, inText.url)).resolves.toMatch(/^blob:/);
    expect(upload).not.toHaveBeenCalled();

    const save = vi.fn((value: { description: string }) => Promise.resolve(value));
    const saved = await saveWithDrafts(
      apiClient,
      'issue',
      { description: `![shot](${inText.url})` },
      save,
    );
    expect(upload).toHaveBeenCalledTimes(1);
    expect(saved.description).toBe(`![shot](${FILE})`);
    // Saved drafts and drafts that were removed before saving are both gone.
    await expect(resolveMedia(apiClient, inText.url)).rejects.toThrow();
    discardDrafts(removed);
    await expect(resolveMedia(apiClient, removed.url)).rejects.toThrow();
  });

  it('removes the uploads again when the save fails', async () => {
    const { apiClient } = client();
    vi.spyOn(apiClient, 'uploadAttachment').mockResolvedValue({
      id: '0f8fad5b-d9cb-469f-a165-70867728950e',
      name: 'shot.png',
      kind: 'image',
      scope: 'pbi',
      source: 'adk',
      url: FILE,
    });
    const remove = vi.spyOn(apiClient, 'deleteAttachment').mockResolvedValue();
    const draft = createDraft('pbi', png());
    await expect(
      saveWithDrafts(apiClient, 'pbi', { attachments: [draft] }, () =>
        Promise.reject(new Error('offline')),
      ),
    ).rejects.toThrow('offline');
    expect(remove).toHaveBeenCalledWith('0f8fad5b-d9cb-469f-a165-70867728950e');
  });

  it('rejects files over the limit before keeping them', () => {
    const big = new File([new Uint8Array(11 * 1024 * 1024)], 'big.png', { type: 'image/png' });
    expect(() => createDraft('brain', big)).toThrow('10 MB');
  });
});
