import { describe, expect, it } from 'vitest';
import { CsvExportError, exportCasesCsv } from '../src/features/testplans/export-csv.js';

const options = {
  format: 'azure' as const,
  areaPath: 'Project\\Team',
  assignedTo: 'qa@example.com',
  state: 'Design',
};
const plan = {
  title: 'Checkout',
  description: 'Description stays in app',
  steps: [{ order: 9, action: 'Click "Pay", now', expectedResult: 'Paid', data: 'a\nb' }],
};
describe('Azure CSV download', () => {
  it('exports descriptions, sequential steps and escaped UTF-8 content without regeneration', () => {
    expect(exportCasesCsv([plan], options)).toBe(
      '\uFEFFID,Work Item Type,Title,Description,Test Step,Step Action,Step Expected,Area Path,Assigned To,State\r\n,Test Case,Checkout,Description stays in app,,,,Project\\Team,qa@example.com,Design\r\n,,,,1,"Click ""Pay"", now\nDados: a\nb",Paid,,,\r\n',
    );
  });
  it('blocks missing destination fields and incomplete cases', () => {
    for (const field of ['areaPath', 'assignedTo', 'state']) {
      expect(() => exportCasesCsv([plan], { ...options, [field]: '' })).toThrow(
        new CsvExportError('MISSING_AZURE_DESTINATION'),
      );
    }
    expect(() => exportCasesCsv([], options)).toThrow(new CsvExportError('INCOMPLETE_CASE'));
    expect(() => exportCasesCsv([{ ...plan, steps: [] }], options)).toThrow(
      new CsvExportError('INCOMPLETE_CASE'),
    );
    expect(() =>
      exportCasesCsv([{ ...plan, steps: [{ action: '', expectedResult: '' }] }], options),
    ).toThrow(new CsvExportError('INCOMPLETE_STEP'));
  });
  it('retains an explicit standard export without Azure destination fields', () => {
    expect(
      exportCasesCsv([plan], { format: 'standard', areaPath: '', assignedTo: '', state: '' }),
    ).toContain('Title,Description,Step,Action,Expected Result,Data');
  });
});
