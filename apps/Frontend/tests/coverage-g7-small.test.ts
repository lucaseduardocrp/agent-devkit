import { describe, expect, it } from 'vitest';
import { CsvExportError, exportCasesCsv } from '../src/features/testplans/export-csv.js';
import { sanitizeRichText } from '../src/features/testplans/test-case-fields.js';

const azure = {
  format: 'azure' as const,
  areaPath: 'Project\Team',
  assignedTo: 'qa@example.com',
  state: 'Design',
};

describe('CSV export of steps', () => {
  it('rejects a step that has an action but no expected result', () => {
    const plan = {
      title: 'Checkout',
      description: 'd',
      steps: [{ order: 1, action: 'Click', expectedResult: '  ' }],
    };
    expect(() => exportCasesCsv([plan], azure)).toThrow(new CsvExportError('INCOMPLETE_STEP'));
  });

  it('keeps steps without data plain in Azure and standard exports', () => {
    const plan = {
      title: 'Checkout',
      description: 'd',
      steps: [{ order: 1, action: 'Click', expectedResult: 'Done' }],
    };
    expect(exportCasesCsv([plan], azure)).toContain(',,,,1,Click,Done,,,\r\n');
    expect(
      exportCasesCsv([plan], { format: 'standard', areaPath: '', assignedTo: '', state: '' }),
    ).toContain('Checkout,d,1,Click,Done,\r\n');
  });
});

describe('sanitizeRichText image attributes', () => {
  it('reads single-quoted and unquoted image attributes', () => {
    expect(sanitizeRichText("<img src='https://x.test/a.png' alt='Logo'>")).toBe(
      '<img src="https://x.test/a.png" alt="Logo">',
    );
    expect(sanitizeRichText('<img src=https://x.test/b.png alt=Logo>')).toBe(
      '<img src="https://x.test/b.png" alt="Logo">',
    );
    expect(sanitizeRichText('<p>a</p><img alt="orphan">')).toBe('<p>a</p>');
    expect(sanitizeRichText('<img src="https://x.test/c.png">')).toBe(
      '<img src="https://x.test/c.png" alt="">',
    );
  });
});
