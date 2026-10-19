import { describe, expect, it } from 'vitest';
import { createSuiteZip } from '../src/features/testplans/export-suite-zip.js';

describe('createSuiteZip', () => {
  it('packages each test plan into the requested suite folder', async () => {
    const archive = createSuiteZip([
      { path: 'Checkout/01 - Pay.csv', content: 'Title\r\nPay\r\n' },
      { path: 'Checkout/02 - Refund.csv', content: 'Title\r\nRefund\r\n' },
    ]);
    const bytes = new Uint8Array(
      await new Promise<ArrayBuffer>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.readAsArrayBuffer(archive);
      }),
    );
    const content = new TextDecoder().decode(bytes);

    expect(archive.type).toBe('application/zip');
    expect(bytes.slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    expect(content).toContain('Checkout/01 - Pay.csv');
    expect(content).toContain('Checkout/02 - Refund.csv');
  });
});
