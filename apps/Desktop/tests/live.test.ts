import { join } from 'node:path';
import { debounce, liveModeFromEnv } from '../src/main/live.js';

describe('liveModeFromEnv', () => {
  const appPath = join('repo', 'apps', 'Desktop');

  it('points at the Vite server and the sibling apps', () => {
    const live = liveModeFromEnv(
      { ADK_DESKTOP_WEB_URL: ' http://localhost:5173 ' },
      appPath,
      false,
    );
    expect(live).toEqual({
      webUrl: 'http://localhost:5173/',
      webOrigin: 'http://localhost:5173',
      backendDir: join('repo', 'apps', 'Backend'),
      mcpDir: join('repo', 'apps', 'Mcp'),
      migrationsDir: join('repo', 'apps', 'Backend', 'prisma', 'migrations'),
    });
  });

  it('is off without the variable and always off in a packaged app', () => {
    expect(liveModeFromEnv({}, appPath, false)).toBeUndefined();
    expect(liveModeFromEnv({ ADK_DESKTOP_WEB_URL: '' }, appPath, false)).toBeUndefined();
    expect(
      liveModeFromEnv({ ADK_DESKTOP_WEB_URL: 'http://localhost:5173' }, appPath, true),
    ).toBeUndefined();
  });

  it('refuses an address that is not http(s)', () => {
    expect(() => liveModeFromEnv({ ADK_DESKTOP_WEB_URL: 'nope' }, appPath, false)).toThrow(
      'not a URL',
    );
    expect(() =>
      liveModeFromEnv({ ADK_DESKTOP_WEB_URL: 'file:///etc/passwd' }, appPath, false),
    ).toThrow('http(s)');
  });
});

describe('debounce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs once, after the last call of a burst', () => {
    const action = vi.fn();
    const call = debounce(action, 500);
    call();
    vi.advanceTimersByTime(300);
    call();
    vi.advanceTimersByTime(300);
    expect(action).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(action).toHaveBeenCalledTimes(1);
    call();
    vi.advanceTimersByTime(500);
    expect(action).toHaveBeenCalledTimes(2);
  });
});
