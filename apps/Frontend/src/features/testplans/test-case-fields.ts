import type { TestManagementProviderId } from '../e2e/e2e-types.js';
import { TEST_MANAGEMENT_NAMES } from '../e2e/e2e-types.js';
import { isSafeImageSource } from '../shared/media.js';

/** Where an imported test case lives on its test management platform. */
export interface TestCaseOrigin {
  readonly provider: string;
  readonly providerName: string;
  readonly caseId: string;
  readonly planId: string;
  readonly suiteId: string;
  readonly url: string | null;
  readonly importedAt: string | null;
}

/** One field brought from the platform, ready to show. */
export interface TestCaseField {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  /** Rich text (HTML) values are shown formatted. */
  readonly html: boolean;
}

/**
 * Keeps only basic formatting tags (no attributes, scripts or styles), so rich text written in
 * ADK or brought from a platform can be shown and edited safely.
 */
export function sanitizeRichText(value: string): string {
  // Images keep only a safe source and their text; they are set aside while the other
  // tags are cleaned and put back rebuilt from those two values.
  const images: string[] = [];
  // Private-use characters mark where each image goes; any in the input are dropped first.
  const shielded = value.replace(/[]/g, '').replace(/<img\b[^>]*>/gi, (tag) => {
    const src = decodeAttribute(attribute(tag, 'src'));
    if (!isSafeImageSource(src)) return '';
    images.push(
      `<img src="${escapeAttribute(src)}" alt="${escapeAttribute(decodeAttribute(attribute(tag, 'alt')))}">`,
    );
    return `${images.length - 1}`;
  });
  return (
    shielded
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<(?!\/?(?:b|strong|i|em|u|br|p|div|h[1-6]|ul|ol|li)\b)[^>]*>/gi, '')
      // Allowed tags lose every attribute, including handlers written without a space.
      .replace(/<(\/?)(b|strong|i|em|u|br|p|div|h[1-6]|ul|ol|li)\b[^>]*>/gi, '<$1$2>')
      .replace(/(\d+)/g, (_, index: string) => images[Number(index)] ?? '')
  );
}

function attribute(tag: string, name: string): string {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? '';
}

function decodeAttribute(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function providerName(provider: string): string {
  return TEST_MANAGEMENT_NAMES[provider as TestManagementProviderId] ?? provider;
}

/** The platform the case was imported from (or published to), when there is one. */
export function testCaseOrigin(
  metadata: Record<string, unknown> | undefined,
): TestCaseOrigin | null {
  const ids = record(metadata?.['remoteCaseIds']);
  const preferred = text(metadata?.['importedFrom']);
  const provider = preferred && ids[preferred] ? preferred : Object.keys(ids)[0];
  const caseId = provider ? text(ids[provider]) : '';
  if (!provider || !caseId) return null;
  const location = record(record(metadata?.['remoteCaseLocations'])[provider]);
  return {
    provider,
    providerName: providerName(provider),
    caseId,
    planId: text(location['planId']),
    suiteId: text(location['suiteId']),
    url: text(record(metadata?.['remoteUrls'])[provider]) || null,
    importedAt: text(metadata?.['importedAt']) || null,
  };
}

/**
 * Fields the platform keeps for the case (state, priority, area, custom fields...), labelled
 * with the platform's names and sorted by label. Empty values are left out.
 */
export function testCaseFields(
  metadata: Record<string, unknown> | undefined,
  provider: string,
): TestCaseField[] {
  const values = record(record(metadata?.['customFields'])[provider]);
  const labels = record(record(metadata?.['customFieldLabels'])[provider]);
  return Object.entries(values)
    .flatMap(([key, raw]) => {
      const value =
        typeof raw === 'boolean'
          ? raw
            ? '✓'
            : '✗'
          : typeof raw === 'string' || typeof raw === 'number'
            ? String(raw)
            : '';
      if (!value) return [];
      return [
        {
          key,
          label: text(labels[key]) || key,
          value,
          html: /<\/?[a-z][^>]*>/i.test(value),
        },
      ];
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}
