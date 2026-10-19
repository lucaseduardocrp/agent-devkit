import type { E2eMode } from '../domain/e2e-mode.js';
import type { AccessServiceToken } from './access-routing.js';

export interface E2ePageSnapshot {
  readonly url: string;
  readonly title: string;
  readonly headings: readonly string[];
  readonly buttons: readonly string[];
  readonly links: readonly { readonly text: string; readonly href: string }[];
  readonly fields: readonly string[];
  readonly testIds: readonly string[];
}

export interface E2eApiSnapshot {
  readonly status: number;
  readonly contentType: string;
  readonly excerpt: string;
  readonly specUrl?: string;
  readonly spec?: string;
}

export interface E2eSnapshot {
  readonly startUrl: string;
  readonly pages: readonly E2ePageSnapshot[];
  readonly api?: E2eApiSnapshot;
}

export interface E2eCredentials {
  readonly username: string | null;
  readonly password: string | null;
}

export interface E2eRunInput {
  readonly script: string;
  readonly mode: E2eMode;
  readonly baseUrl: string;
  readonly localOrigin?: string | null;
  readonly locale: string;
  readonly credentials: E2eCredentials;
  readonly accessToken?: AccessServiceToken | null;
  readonly signal?: AbortSignal;
}

export interface E2eRunResult {
  readonly status: 'passed' | 'failed';
  readonly durationMs: number;
  readonly error: string | null;
  readonly logs: string;
  readonly video: Uint8Array | null;
  /** One entry per top-level `test.step`, in execution order. */
  readonly steps: readonly E2eStepEvidence[];
  /** Computer of the local runner that executed the spec; absent on the ADK workers. */
  readonly executedOn?: string | null;
}

export interface E2eStepEvidence {
  readonly position: number;
  readonly title: string;
  readonly status: 'passed' | 'failed';
  readonly durationMs: number;
  readonly error: string | null;
  /** PNG of the page when the step ended (UI tests only). */
  readonly screenshot: Uint8Array | null;
}

export interface E2eRunner {
  explore(input: {
    mode: E2eMode;
    url: string;
    transportUrl?: string;
    signal?: AbortSignal;
    accessToken?: AccessServiceToken | null;
  }): Promise<E2eSnapshot>;
  run(input: E2eRunInput): Promise<E2eRunResult>;
}

/** Converts recordings to a widely playable format; returns null when conversion fails. */
export interface E2eVideoTranscoder {
  toMp4(webm: Uint8Array): Promise<Uint8Array | null>;
}

export type E2eRunnerErrorCode =
  | 'E2E_BROWSER_NOT_INSTALLED'
  | 'E2E_TARGET_UNREACHABLE'
  | 'E2E_RUNNER_FAILED'
  | 'E2E_LOCAL_RUNNER_UNAVAILABLE'
  | 'E2E_LOCAL_RUNNER_LOST';

export class E2eRunnerError extends Error {
  constructor(
    public readonly code: E2eRunnerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'E2eRunnerError';
  }
}

const SECRET_PATTERN =
  /(authorization|token|password|secret|cookie)(["']?\s*[:=]\s*["']?)(?:(?:bearer|basic)\s+)?[^\s,;"']+/gi;

/** Removes known credential values and common secret shapes from runner output. */
export function redact(value: string, secrets: readonly (string | null | undefined)[]): string {
  let result = value.replace(SECRET_PATTERN, '$1$2[redacted]');
  for (const secret of secrets) {
    if (secret && secret.length >= 3) result = result.split(secret).join('[redacted]');
  }
  return result;
}

export function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}
