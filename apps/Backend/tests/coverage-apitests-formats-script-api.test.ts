import { describe, expect, it } from 'vitest';
import { fromAdkScripts, toAdkScripts } from '../src/modules/apitests/formats/script-api.js';

describe('script API renaming', () => {
  it('leaves absent scripts untouched', () => {
    expect(toAdkScripts(undefined)).toBeUndefined();
    expect(fromAdkScripts(undefined, 'pm')).toBeUndefined();
  });

  it('renames the scripts of each phase and keeps values that are not text', () => {
    const imported = toAdkScripts({
      preRequest: 'bru.setVar("a", 1)',
      postResponse: undefined,
      tests: 'pm.test("x", () => insomnia.x())',
    });
    expect(imported).toEqual({
      preRequest: 'adk.setVar("a", 1)',
      postResponse: undefined,
      tests: 'adk.test("x", () => adk.x())',
    });
    expect(fromAdkScripts(imported, 'bru')).toEqual({
      preRequest: 'bru.setVar("a", 1)',
      postResponse: undefined,
      tests: 'bru.test("x", () => bru.x())',
    });
  });
});
