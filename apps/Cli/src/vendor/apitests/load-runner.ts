import { executeRequest, scopeOf } from './http-request.js';
import { peakVus, totalDuration, vusAt } from './load-profiles.js';
import type {
  LatencySummary,
  LoadMetric,
  LoadPlan,
  LoadSummary,
  LoadThreshold,
  LoadTick,
  ThresholdResult,
} from './types.js';

/** Latencies are counted per millisecond up to one minute; slower answers share the last slot. */
const HISTOGRAM_MS = 60_000;

class Histogram {
  private readonly counts = new Uint32Array(HISTOGRAM_MS + 1);
  count = 0;
  sum = 0;
  min = Number.POSITIVE_INFINITY;
  max = 0;

  add(ms: number): void {
    const value = Math.max(0, Math.round(ms));
    this.counts[Math.min(value, HISTOGRAM_MS)]! += 1;
    this.count += 1;
    this.sum += value;
    this.min = Math.min(this.min, value);
    this.max = Math.max(this.max, value);
  }

  percentile(p: number): number {
    if (!this.count) return 0;
    const rank = Math.ceil((p / 100) * this.count);
    // rank <= count, so the walk always stops inside the array.
    let ms = 0;
    for (let seen = this.counts[0]!; seen < rank; seen += this.counts[ms]!) ms += 1;
    return ms;
  }

  summary(): LatencySummary {
    return {
      min: this.count ? this.min : 0,
      avg: this.count ? Math.round(this.sum / this.count) : 0,
      p50: this.percentile(50),
      p90: this.percentile(90),
      p95: this.percentile(95),
      p99: this.percentile(99),
      max: this.max,
    };
  }
}

function percentileOf(sorted: readonly number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function compare(actual: number, threshold: LoadThreshold): boolean {
  switch (threshold.operator) {
    case 'lt':
      return actual < threshold.value;
    case 'lte':
      return actual <= threshold.value;
    case 'gt':
      return actual > threshold.value;
    case 'gte':
      return actual >= threshold.value;
  }
}

export interface LoadRunOptions {
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly guard?: (url: URL) => Promise<void>;
  /** Hard limit on virtual users, whatever the stages say. */
  readonly maxVus?: number;
  /** Called once a second with the last second and the summary so far. */
  readonly onTick?: (tick: LoadTick, summary: LoadSummary) => void | Promise<void>;
  /** Interval of the VU controller and of the ticks; only tests change them. */
  readonly controlMs?: number;
  readonly tickMs?: number;
}

/**
 * Generates load like k6's ramping-VUs executor: each virtual user loops over the weighted
 * requests (with its own variables, so captures stay per user), pausing `thinkTimeMs` between
 * requests, while a controller grows or shrinks the number of users along the stages.
 */
export async function runLoad(plan: LoadPlan, options: LoadRunOptions = {}): Promise<LoadSummary> {
  if (!plan.requests.length) throw new Error('A load test needs at least one request.');
  const tickMs = options.tickMs ?? 1_000;
  const controlMs = options.controlMs ?? 100;
  const maxVus = Math.max(1, options.maxVus ?? Number.POSITIVE_INFINITY);
  const stages = plan.stages;
  const totalSec = totalDuration(stages);
  // Requests without a positive weight share the traffic equally.
  const given = plan.requests.map((entry) => Math.max(0, entry.weight));
  const weights = given.some(Boolean) ? given : given.map(() => 1);
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const pick = () => {
    let roll = Math.random() * weightSum;
    for (const [index, weight] of weights.entries()) {
      roll -= weight;
      if (roll < 0) return plan.requests[index]!;
    }
    return plan.requests.at(-1)!;
  };

  const overall = new Histogram();
  const perRequest = new Map(
    plan.requests.map((entry) => [
      entry.request.id,
      { name: entry.request.name, histogram: new Histogram(), failed: 0 },
    ]),
  );
  const statusCodes: Record<string, number> = {};
  const errors: Record<string, number> = {};
  let failed = 0;
  let checksPassed = 0;
  let checksFailed = 0;
  let maxSeenVus = 0;
  let bucket: { latencies: number[]; errors: number } = { latencies: [], errors: 0 };
  const timeline: LoadTick[] = [];

  const stop = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
  const started = performance.now();
  const elapsedSec = () => (performance.now() - started) / 1_000;
  let desired = 0;
  let abortedBy: LoadMetric | undefined;
  const alive = new Map<number, Promise<void>>();

  const record = (requestId: string, result: Awaited<ReturnType<typeof executeRequest>>) => {
    const failedRequest = result.status === null || result.status >= 400;
    overall.add(result.durationMs);
    const stats = perRequest.get(requestId)!;
    stats.histogram.add(result.durationMs);
    bucket.latencies.push(result.durationMs);
    const code = result.status === null ? 'error' : String(result.status);
    statusCodes[code] = (statusCodes[code] ?? 0) + 1;
    for (const assertion of result.assertions) {
      if (assertion.passed) checksPassed += 1;
      else checksFailed += 1;
    }
    if (failedRequest) {
      failed += 1;
      stats.failed += 1;
      bucket.errors += 1;
      const reason = (result.error ?? `HTTP ${result.status}`).slice(0, 120);
      errors[reason] = (errors[reason] ?? 0) + 1;
    }
  };

  const virtualUser = async (id: number) => {
    const scope = scopeOf(plan.variables);
    while (!signal.aborted && id < desired) {
      const entry = pick();
      const result = await executeRequest(entry.request, scope, {
        auth: entry.auth,
        signal,
        ...(plan.timeoutMs ? { timeoutMs: plan.timeoutMs } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.guard ? { guard: options.guard } : {}),
      });
      // A request cut by the end of the test is not a result.
      if (signal.aborted && result.status === null) break;
      record(entry.request.id, result);
      if (plan.thinkTimeMs > 0) await sleep(plan.thinkTimeMs, signal);
    }
  };

  const metric = (name: LoadMetric, durationSec: number): number => {
    const latency = overall.summary();
    switch (name) {
      case 'errorRate':
        return overall.count ? failed / overall.count : 0;
      case 'rps':
        // durationSec is never below 1 ms (see summarize).
        return overall.count / durationSec;
      case 'checksRate':
        return checksPassed + checksFailed ? checksPassed / (checksPassed + checksFailed) : 1;
      default:
        return latency[name];
    }
  };

  const summarize = (): LoadSummary => {
    const durationSec = Math.max(elapsedSec(), 0.001);
    const thresholds: ThresholdResult[] = plan.thresholds.map((threshold) => {
      const actual = metric(threshold.metric, durationSec);
      return {
        ...threshold,
        actual: Math.round(actual * 10_000) / 10_000,
        passed: compare(actual, threshold),
      };
    });
    return {
      durationSec: Math.round(durationSec * 10) / 10,
      maxVus: maxSeenVus,
      totalRequests: overall.count,
      failedRequests: failed,
      errorRate: overall.count ? failed / overall.count : 0,
      rps: Math.round((overall.count / durationSec) * 10) / 10,
      latency: overall.summary(),
      checks: { passed: checksPassed, failed: checksFailed },
      statusCodes: { ...statusCodes },
      errors: { ...errors },
      perRequest: [...perRequest.entries()].map(([requestId, stats]) => ({
        requestId,
        name: stats.name,
        count: stats.histogram.count,
        failed: stats.failed,
        avg: stats.histogram.summary().avg,
        p95: stats.histogram.percentile(95),
      })),
      thresholds,
      passed: thresholds.every((threshold) => threshold.passed),
      ...(abortedBy ? { abortedBy } : {}),
      timeline: [...timeline],
    };
  };

  const control = setInterval(() => {
    const elapsed = elapsedSec();
    desired = elapsed >= totalSec ? 0 : Math.min(maxVus, vusAt(stages, elapsed));
    for (let id = 0; id < desired; id += 1) {
      if (alive.has(id)) continue;
      const user: Promise<void> = virtualUser(id).finally(() => alive.delete(id));
      alive.set(id, user);
    }
    maxSeenVus = Math.max(maxSeenVus, alive.size);
    if (elapsed >= totalSec) stop.abort();
  }, controlMs);

  let ticking: Promise<void> = Promise.resolve();
  const ticker = setInterval(() => {
    const current = bucket;
    bucket = { latencies: [], errors: 0 };
    const sorted = current.latencies.sort((a, b) => a - b);
    const tick: LoadTick = {
      t: Math.round(elapsedSec()),
      vus: alive.size,
      requests: sorted.length,
      errors: current.errors,
      avg: sorted.length ? Math.round(sorted.reduce((sum, ms) => sum + ms, 0) / sorted.length) : 0,
      p50: percentileOf(sorted, 50),
      p95: percentileOf(sorted, 95),
      p99: percentileOf(sorted, 99),
    };
    timeline.push(tick);
    const summary = summarize();
    if (elapsedSec() >= 10) {
      const broken = summary.thresholds.find(
        (threshold) => threshold.abortOnFail && !threshold.passed,
      );
      if (broken && !abortedBy) {
        abortedBy = broken.metric;
        stop.abort();
      }
    }
    ticking = ticking.then(() => options.onTick?.(tick, summary)).catch(() => undefined);
  }, tickMs);

  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
  clearInterval(control);
  desired = 0;
  await Promise.allSettled([...alive.values()]);
  clearInterval(ticker);
  await ticking;
  return summarize();
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export { peakVus, totalDuration };
