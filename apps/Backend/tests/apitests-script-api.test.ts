import { describe, expect, it } from 'vitest';
import {
  fromAdkScript,
  fromAdkScripts,
  toAdkScript,
  toAdkScripts,
} from '../src/modules/apitests/formats/script-api.js';

describe('script API names across tools', () => {
  it('renames the object of Bruno, Postman and Insomnia scripts to adk', () => {
    expect(
      toAdkScript(
        [
          "bru.setVar('token', res.getBody().token);",
          "pm.environment.set('a', 1); postman.setGlobalVariable('b', 2);",
          "insomnia.environment.set('c', 3);",
          'await bru . sendRequest({ url: "https://x.test" });',
        ].join('\n'),
      ),
    ).toBe(
      [
        "adk.setVar('token', res.getBody().token);",
        "adk.environment.set('a', 1); adk.setGlobalVariable('b', 2);",
        "adk.environment.set('c', 3);",
        'await adk . sendRequest({ url: "https://x.test" });',
      ].join('\n'),
    );
  });

  it('leaves members, longer names and lone words alone', () => {
    const untouched = [
      'const value = data.pm.total;',
      'const pmValue = 1; const brunoName = "bru";',
      'const pm = 3;',
      "fetch('https://www.postman.com/api');",
    ].join('\n');
    expect(toAdkScript(untouched)).toBe(untouched);
  });

  it('renames adk back to the object of the tool an export is for', () => {
    const script = "adk.setVar('id', res.getBody().id);\nconst adkName = data.adk.name;";
    expect(fromAdkScript(script, 'bru')).toBe(
      "bru.setVar('id', res.getBody().id);\nconst adkName = data.adk.name;",
    );
    expect(fromAdkScript(script, 'pm')).toContain("pm.setVar('id'");
    expect(fromAdkScript(script, 'insomnia')).toContain("insomnia.setVar('id'");
  });

  it('maps every phase of the scripts of an item', () => {
    expect(
      toAdkScripts({ preRequest: 'bru.setVar("a", 1);', postResponse: 'pm.test("t", () => {});' }),
    ).toEqual({ preRequest: 'adk.setVar("a", 1);', postResponse: 'adk.test("t", () => {});' });
    expect(fromAdkScripts({ tests: 'adk.getVar("a")' }, 'bru')).toEqual({
      tests: 'bru.getVar("a")',
    });
    expect(toAdkScripts(undefined)).toBeUndefined();
  });
});
