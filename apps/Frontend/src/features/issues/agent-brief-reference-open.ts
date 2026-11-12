import type { ApiClient } from '../../lib/api-client.js';
import type { Attachment } from '../shared/attachment-types.js';
import { resolveMedia } from '../shared/media.js';

/**
 * Opens an attached file where the browser can show it (images, PDFs) or save it. The tab is
 * opened before the file is fetched so the click is still what opened it and no popup blocker
 * stops it.
 */
export async function openReferencedFile(apiClient: ApiClient, file: Attachment): Promise<void> {
  if (file.source === 'url') {
    window.open(file.url, '_blank', 'noopener,noreferrer');
    return;
  }
  const tab = window.open('', '_blank');
  try {
    const url = await resolveMedia(apiClient, file.url);
    if (tab) {
      tab.opener = null;
      tab.location.href = url;
      return;
    }
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    link.click();
  } catch (error) {
    tab?.close();
    throw error;
  }
}
