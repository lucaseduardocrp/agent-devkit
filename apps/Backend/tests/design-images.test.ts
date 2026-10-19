import { describe, expect, it } from 'vitest';
import { designImagesSchema } from '../src/adapters/http/design-routes.js';

const png = Buffer.from('89504e470d0a1a0a00000000', 'hex').toString('base64');

describe('design image validation', () => {
  it('accepts supported image data and enforces the declared media type', () => {
    expect(designImagesSchema.parse([{ mimeType: 'image/png', data: png }])).toHaveLength(1);
    expect(() => designImagesSchema.parse([{ mimeType: 'image/jpeg', data: png }])).toThrow();
  });

  it('rejects more than four images and payloads larger than five megabytes', () => {
    const image = { mimeType: 'image/png' as const, data: png };
    expect(() => designImagesSchema.parse(Array.from({ length: 5 }, () => image))).toThrow();
    const oversized = Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      Buffer.alloc(5 * 1024 * 1024),
    ]).toString('base64');
    expect(() => designImagesSchema.parse([{ mimeType: 'image/png', data: oversized }])).toThrow();
  });
});
