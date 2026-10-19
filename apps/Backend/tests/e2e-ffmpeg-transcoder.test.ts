import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  FfmpegVideoTranscoder,
  resolveFfmpegPath,
} from '../src/modules/e2e/adapters/ffmpeg-transcoder.js';
import type { ProcessExecutor } from '../src/modules/e2e/adapters/playwright-runner.js';

describe('FfmpegVideoTranscoder', () => {
  it('re-encodes WebM to H.264 MP4 and cleans up its work directory', async () => {
    let workDir = '';
    const executor: ProcessExecutor = vi.fn(({ cwd, args }) => {
      workDir = cwd;
      expect(fs.readFileSync(args[args.indexOf('-i') + 1]!, 'utf8')).toBe('webm');
      expect(args).toEqual(expect.arrayContaining(['libx264', '+faststart', 'yuv420p']));
      fs.writeFileSync(args.at(-1)!, 'mp4');
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
    });
    const transcoder = new FfmpegVideoTranscoder({ ffmpegPath: 'ffmpeg', executor });
    expect(Buffer.from((await transcoder.toMp4(Buffer.from('webm')))!).toString()).toBe('mp4');
    expect(fs.existsSync(workDir)).toBe(false);
  });

  it('returns null when ffmpeg fails, times out, produces nothing or cannot start', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const run = (result: Awaited<ReturnType<ProcessExecutor>> | Error, write = false) =>
      new FfmpegVideoTranscoder({
        ffmpegPath: 'ffmpeg',
        executor: ({ args }) => {
          if (write) fs.writeFileSync(args.at(-1)!, '');
          return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
        },
      }).toMp4(Buffer.from('webm'));
    expect(
      await run({ exitCode: 1, stdout: '', stderr: 'Invalid data', timedOut: false }),
    ).toBeNull();
    expect(await run({ exitCode: 0, stdout: '', stderr: '', timedOut: true })).toBeNull();
    expect(await run({ exitCode: 0, stdout: '', stderr: '', timedOut: false }, true)).toBeNull();
    expect(await run(new Error('ENOENT'))).toBeNull();
    expect(errorLog).toHaveBeenCalledTimes(3);
    errorLog.mockRestore();
  });

  it('resolves the ffmpeg binary from the environment or the bundled package', () => {
    expect(resolveFfmpegPath({ FFMPEG_PATH: '/usr/bin/ffmpeg' })).toBe('/usr/bin/ffmpeg');
    expect(resolveFfmpegPath({}, () => ({ path: '/bundled/ffmpeg' }))).toBe('/bundled/ffmpeg');
    expect(resolveFfmpegPath({}, () => ({}))).toBeNull();
    expect(
      resolveFfmpegPath({}, () => {
        throw new Error('not installed');
      }),
    ).toBeNull();
    expect(resolveFfmpegPath({})).toEqual(expect.any(String));
  });
});
