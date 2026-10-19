import { describe, expect, it } from 'vitest';
import {
  aggregateOutcome,
  decodeEntities,
  describeStep,
  formatElapsed,
  htmlToText,
  isTestManagementProvider,
} from '../src/modules/test-management/domain/test-run.js';

describe('test management domain helpers', () => {
  it('recognizes the supported providers', () => {
    expect(isTestManagementProvider('azure_devops')).toBe(true);
    expect(isTestManagementProvider('testrail')).toBe(true);
    expect(isTestManagementProvider('xray')).toBe(true);
    expect(isTestManagementProvider('jira')).toBe(false);
    expect(isTestManagementProvider('')).toBe(false);
  });

  it('aggregates step outcomes into the case outcome', () => {
    expect(aggregateOutcome([])).toBe('not_executed');
    expect(aggregateOutcome(['passed', 'failed', 'blocked'])).toBe('failed');
    expect(aggregateOutcome(['passed', 'blocked'])).toBe('blocked');
    expect(aggregateOutcome(['passed', 'passed'])).toBe('passed');
    expect(aggregateOutcome(['passed', 'not_executed'])).toBe('blocked');
    expect(aggregateOutcome(['not_executed', 'not_executed'])).toBe('not_executed');
  });

  it('formats elapsed time with at least one second', () => {
    expect(formatElapsed(0)).toBe('1s');
    expect(formatElapsed(-500)).toBe('1s');
    expect(formatElapsed(5_400)).toBe('5s');
    expect(formatElapsed(60_000)).toBe('1m');
    expect(formatElapsed(92_000)).toBe('1m 32s');
    expect(formatElapsed(3_600_000)).toBe('60m');
  });

  it('decodes named, decimal and hexadecimal entities', () => {
    expect(decodeEntities('&amp; &lt; &gt; &quot; &apos; &nbsp;')).toBe('& < > " \'  ');
    expect(decodeEntities('&AMP;&Lt;')).toBe('&<');
    expect(decodeEntities('&#65;&#x42;&#X43;&#x1F600;')).toBe('ABC\u{1F600}');
    expect(decodeEntities('&unknown; & plain ;')).toBe('&unknown; & plain ;');
    expect(decodeEntities('no entities')).toBe('no entities');
  });

  it('turns rich text into plain lines', () => {
    expect(
      htmlToText(
        '<div>Open   the <b>login</b> page</div><p>Type&nbsp;&quot;admin&quot;</p>' +
          'line<br>break<BR/>again<br />end</p><ul><li>one</li><li> two </li></ul><h2>Title</h2>',
      ),
    ).toBe('Open the login page\nType "admin"\nline\nbreak\nagain\nend\none\ntwo\nTitle');
    expect(htmlToText('&lt;script&gt;')).toBe('<script>');
    expect(htmlToText('   ')).toBe('');
    expect(htmlToText('')).toBe('');
  });

  it('describes a step with its expected result', () => {
    expect(describeStep({ action: ' Click\n  save ', expectedResult: ' Saved\tmessage ' })).toBe(
      'Click save => Saved message',
    );
    expect(describeStep({ action: 'Open the page', expectedResult: '   ' })).toBe('Open the page');
    expect(describeStep({ action: 'x'.repeat(1_200), expectedResult: '' })).toHaveLength(1_000);
  });
});
