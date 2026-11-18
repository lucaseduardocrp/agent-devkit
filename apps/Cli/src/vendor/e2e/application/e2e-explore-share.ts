/** A test as the exploration reads it. */
export interface ExploreTest {
  /** What the agent receives the test by (its code). */
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly steps: readonly string[];
}

/** The small piece of work one browser takes at a time. */
export interface ExploreBatch {
  /** Menu items, tabs and links to walk through. */
  readonly areas: readonly string[];
  /** Ids of the tests whose flows to walk through. */
  readonly tests: readonly string[];
}

/** Tests and areas a browser takes per round: small, so work that is left can still be moved. */
const BATCH_TESTS = 2;
const BATCH_AREAS = 2;

const plain = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const words = (text: string) =>
  plain(text)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4);

/** Same word, whatever the number or ending: "colaborador" and "colaboradores". */
function sameWord(a: string, b: string): boolean {
  const need = Math.max(5, Math.floor(Math.min(a.length, b.length) * 0.8));
  let common = 0;
  while (common < Math.min(a.length, b.length) && a[common] === b[common]) common += 1;
  return common >= need || (a === b && a.length >= 4);
}

/** How much a test talks about an area: its whole name counts more than shared words. */
function affinity(text: string, vocabulary: readonly string[], area: string): number {
  const label = plain(area).trim();
  if (!label) return 0;
  if (text.includes(label)) return 3;
  let score = 0;
  for (const word of words(area))
    if (vocabulary.some((candidate) => sameWord(candidate, word))) score += 1;
  return score;
}

/**
 * The work of a parallel exploration, shared by its browsers: the areas of the navigation and the
 * tests of the run. Each browser starts with what is closest to it (its areas, and the tests that
 * talk about them); work that no area claims goes to whoever is free first, and a browser that
 * runs out takes what another still has waiting. Nothing is given twice and nothing is lost.
 */
export class ExploreWorkPool {
  private readonly areas: string[][];
  private readonly tests: string[][];
  /** Tests that talk about no area: the first browser with room takes them. */
  private readonly open: string[] = [];
  /** Browsers that took their first piece of work: only their queues can be taken from. */
  private readonly started: boolean[];

  constructor(shares: readonly (readonly string[])[], tests: readonly ExploreTest[]) {
    this.areas = shares.map((share) => [...share]);
    this.tests = shares.map(() => []);
    this.started = shares.map(() => false);
    for (const test of tests) {
      const text = plain([test.title, test.description, ...test.steps].join(' '));
      const vocabulary = words(text);
      let best = -1;
      let bestScore = 0;
      shares.forEach((share, worker) => {
        const score = share.reduce((sum, area) => sum + affinity(text, vocabulary, area), 0);
        // A tie goes to the browser with fewer tests.
        if (
          score > bestScore ||
          (score === bestScore &&
            score > 0 &&
            this.tests[worker]!.length < this.tests[best]!.length)
        ) {
          best = worker;
          bestScore = score;
        }
      });
      if (best < 0) this.open.push(test.id);
      else this.tests[best]!.push(test.id);
    }
  }

  /** The next piece of work for a browser (0-based); null when nothing is left for it to take. */
  claim(worker: number): ExploreBatch | null {
    this.started[worker] = true;
    const tests = this.take(this.tests, worker, BATCH_TESTS, this.open);
    const areas = this.take(this.areas, worker, BATCH_AREAS);
    return tests.length || areas.length ? { areas, tests } : null;
  }

  /** A browser that cannot work (or is done for good): what it had waiting can be taken. */
  release(worker: number): void {
    this.started[worker] = true;
  }

  /** Every browser is free to take from every queue: the work left must not stay undone. */
  releaseAll(): void {
    this.started.fill(true);
  }

  /** Work that no browser has taken yet. */
  get remaining(): number {
    return (
      this.open.length +
      this.tests.reduce((sum, queue) => sum + queue.length, 0) +
      this.areas.reduce((sum, queue) => sum + queue.length, 0)
    );
  }

  /**
   * Own queue first, then the work no area claims, then the back half of the longest queue of a
   * browser that is already working (one that has not started keeps what it has: it is about to).
   */
  private take(queues: string[][], worker: number, size: number, open: string[] = []): string[] {
    const own = queues[worker]!;
    if (own.length) return own.splice(0, size);
    if (open.length) return open.splice(0, size);
    let victim: string[] | null = null;
    for (const [index, queue] of queues.entries())
      if (index !== worker && this.started[index] && queue.length > (victim?.length ?? 0))
        victim = queue;
    return victim ? victim.splice(-Math.min(size, Math.ceil(victim.length / 2))) : [];
  }
}
