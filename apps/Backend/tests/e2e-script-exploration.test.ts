import { describe, expect, it } from 'vitest';
import { scriptExploration } from '../src/modules/e2e/domain/e2e-source.js';

const page = (title: string, url = `http://app/${title}`) => ({
  index: 1,
  url,
  title,
  summary: `${title} summary`,
  elements: ['Save', 'Export'],
  hasScreenshot: false,
});

describe('scriptExploration', () => {
  it('is null when nothing was discovered', () => {
    expect(scriptExploration([null, undefined])).toBeNull();
  });

  it('merges explorations without repeats, drops notes and keeps the first one first', () => {
    const own = {
      pages: [page('Dashboard')],
      script: [
        { atMs: 1, action: 'click' as const, target: 'Filters', result: 'Dashboard', reason: 'open filters' },
        { atMs: 2, action: 'note' as const, target: 'x', result: null },
      ],
    };
    const source = { pages: [page('Dashboard'), page('Reports')], script: [own.script[0]!] };
    const merged = scriptExploration([own, source])!;
    expect(merged.pages.map((p) => p.name)).toEqual(['Dashboard', 'Reports']);
    expect(merged.navigation).toEqual([
      { action: 'click', target: 'Filters', ledTo: 'Dashboard', why: 'open filters' },
    ]);
  });
});
