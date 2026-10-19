import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { E2eVideoTranscoder } from '../application/e2e-runner.js';
import { runProcess, type ProcessExecutor } from './playwright-runner.js';

export interface FfmpegVideoTranscoderOptions {
  readonly ffmpegPath: string;
  readonly executor?: ProcessExecutor;
  readonly workRoot?: string;
  readonly timeoutMs?: number;
}

/**
 * Playwright records WebM (VP8). Some Chromium embeds, such as the VS Code integrated
 * browser, ship an FFmpeg without the WebM demuxer, so recordings are re-encoded to
 * H.264 MP4, which every supported browser and VS Code can play.
 */
export class FfmpegVideoTranscoder implements E2eVideoTranscoder {
  private readonly executor: ProcessExecutor;
  private readonly workRoot: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: FfmpegVideoTranscoderOptions) {
    this.executor = options.executor ?? runProcess;
    this.workRoot = options.workRoot ?? os.tmpdir();
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async toMp4(webm: Uint8Array): Promise<Uint8Array | null> {
    const directory = await fs.mkdtemp(path.join(this.workRoot, 'e2e-video-'));
    const mp4 = await this.convert(directory, webm).catch((error: unknown) => {
      console.error('[E2E] Video conversion failed:', error);
      return null;
    });
    await fs.rm(directory, { recursive: true, force: true });
    return mp4;
  }

  private async convert(directory: string, webm: Uint8Array): Promise<Uint8Array | null> {
    const input = path.join(directory, 'input.webm');
    const output = path.join(directory, 'output.mp4');
    await fs.writeFile(input, webm);
    const result = await this.executor({
      command: this.options.ffmpegPath,
      args: [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        input,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '26',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        '-an',
        output,
      ],
      cwd: directory,
      // Only what the binary needs to start; no backend secrets.
      env: { PATH: process.env['PATH'], SystemRoot: process.env['SystemRoot'] },
      timeoutMs: this.timeoutMs,
    });
    if (result.exitCode !== 0 || result.timedOut) {
      console.error('[E2E] Video conversion failed:', result.stderr.slice(-2_000));
      return null;
    }
    const mp4 = await fs.readFile(output);
    return mp4.byteLength ? mp4 : null;
  }
}

/** FFMPEG_PATH wins; otherwise the binary bundled by @ffmpeg-installer/ffmpeg, if installed. */
export function resolveFfmpegPath(
  env: NodeJS.ProcessEnv = process.env,
  load: (id: string) => unknown = createRequire(import.meta.url),
): string | null {
  if (env['FFMPEG_PATH']) return env['FFMPEG_PATH'];
  try {
    const bundled = (load('@ffmpeg-installer/ffmpeg') as { path?: unknown }).path;
    return typeof bundled === 'string' ? bundled : null;
  } catch {
    return null;
  }
}
