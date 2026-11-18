import { describe, expect, it } from 'vitest';
import { ExplorationRecorder } from '../src/modules/e2e/application/e2e-exploration.js';
import type { E2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import type { E2ePageSnapshot } from '../src/modules/e2e/application/e2e-runner.js';

const page: E2ePageSnapshot = {
  url: 'http://app/planning',
  title: 'Blue - Planning',
  headings: ['Planning'],
  dialog: 'Legend',
  buttons: ['Save', 'Close'],
  links: [],
  fields: [],
  testIds: [],
};

function memoryStore() {
  const files = new Map<string, Buffer>();
  const store = {
    get: async (key: string) => files.get(key) ?? null,
    put: async (key: string, content: Uint8Array) => void files.set(key, Buffer.from(content)),
    removePrefix: async () => undefined,
  } as unknown as E2eArtifactStore;
  return store;
}

describe('ExplorationRecorder', () => {
  it('calls a capture by the flow it is the evidence of, and keeps the screen it shows', async () => {
    const recorder = await ExplorationRecorder.start(
      memoryStore(),
      { workspaceId: 'ws', id: 'c' },
      false,
    );
    recorder.onProgress({ kind: 'page', page, screenshot: new Uint8Array([1]) });
    recorder.onProgress({
      kind: 'page',
      page,
      screenshot: new Uint8Array([2]),
      flow: 'Open the legend',
    });
    await recorder.finish();
    const state = await (
      await import('../src/modules/e2e/application/e2e-exploration.js')
    ).readExploration((recorder as unknown as { artifacts: E2eArtifactStore }).artifacts, {
      workspaceId: 'ws',
      id: 'c',
    });
    expect(state?.pages.map((item) => [item.title, item.flow])).toEqual([
      ['Planning · Legend', undefined],
      ['Open the legend', 'Open the legend'],
    ]);
    expect(state?.pages[1]?.summary.startsWith('Planning · Legend · ')).toBe(true);
  });
});
