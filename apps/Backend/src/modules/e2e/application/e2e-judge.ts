import type { LlmImage } from '../../agents/application/agent-ports.js';
import { detectImageMimeType, MAX_IMAGE_BYTES } from '../../shared/image-attachment.js';
import type { E2eTestCase } from '../domain/e2e.js';
import type { E2eAnalysis } from './e2e-author.js';

/** Most screenshots the judge looks at: the steps that failed and the screen the test ended on. */
const MAX_EVIDENCE_IMAGES = 3;

/**
 * The steps whose screenshots tell the judge what the user saw: the ones that failed first, then
 * the last one. Without the picture of the screen, a failure caused by a locator that matched a
 * hidden element cannot be told from a real defect.
 */
export function evidenceSteps<T extends { readonly status: 'passed' | 'failed' }>(
  steps: readonly T[],
): T[] {
  const last = steps.at(-1);
  const picked = [...steps.filter((step) => step.status === 'failed').slice(0, 2)];
  if (last && !picked.includes(last)) picked.push(last);
  return picked.slice(0, MAX_EVIDENCE_IMAGES);
}

/** Pictures the model can read; anything that is not a supported image, or is too big, is left out. */
export function toLlmImages(pictures: readonly (Uint8Array | null | undefined)[]): LlmImage[] {
  const images: LlmImage[] = [];
  for (const picture of pictures) {
    if (!picture || picture.byteLength > MAX_IMAGE_BYTES) continue;
    const mimeType = detectImageMimeType(picture);
    if (mimeType) images.push({ mimeType, data: Buffer.from(picture).toString('base64') });
  }
  return images;
}

/**
 * Whether a run that failed counts as passed: only when the user wrote success criteria and the
 * judge found the evidence meets them. Without criteria nothing is ever promoted automatically.
 */
export function meetsCriteria(
  test: Pick<E2eTestCase, 'successCriteria'>,
  analysis: Pick<E2eAnalysis, 'criteriaMet'> | null,
): boolean {
  return Boolean(test.successCriteria?.trim()) && analysis?.criteriaMet === true;
}
