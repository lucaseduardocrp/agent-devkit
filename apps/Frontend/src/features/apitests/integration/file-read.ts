import { getMessages } from '../../../lib/i18n/index.js';

// Reads files picked in the settings (certificates, proto files, data files) in the browser.

function read(file: Blob, as: 'text' | 'dataUrl'): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error(getMessages().apiTests.fileReadError));
    if (as === 'text') reader.readAsText(file);
    else reader.readAsDataURL(file);
  });
}

export const readFileText = (file: Blob) => read(file, 'text');

/** The content as base64, without the `data:...;base64,` prefix. */
export async function readFileBase64(file: Blob): Promise<string> {
  const url = await read(file, 'dataUrl');
  return url.slice(url.indexOf(',') + 1);
}

/** The path of a picked file inside the picked folder, or its name. */
export const relativeName = (file: File) =>
  (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;

/** A readable message for whatever was thrown. */
export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
