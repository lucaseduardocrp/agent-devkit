import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ResizableBox } from './ResizableBox.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import type { DesktopDevelopmentBridge } from '../../lib/desktop.js';
import { useI18n } from '../../lib/i18n/index.js';

interface Props {
  readonly sessionId: string;
  readonly desktop: DesktopDevelopmentBridge;
}

/** How much output the panel keeps; older lines scroll away. */
const MAX_OUTPUT = 200_000;

/**
 * A terminal in the session's worktree (desktop app only). Each line runs in a shell of its own
 * on this computer and its output shows as it comes; `cd` is followed between lines.
 */
export function TerminalPane({ sessionId, desktop }: Props) {
  const { messages } = useI18n();
  const c = messages.development;
  const [output, setOutput] = useState('');
  const [cwd, setCwd] = useState('');
  const [running, setRunning] = useState(false);
  const [line, setLine] = useState('');
  const screen = useRef<HTMLPreElement>(null);
  const append = (text: string) => setOutput((current) => (current + text).slice(-MAX_OUTPUT));

  useEffect(() => {
    void desktop.terminalFolder(sessionId).then((result) => {
      if (result.ok) setCwd(result.cwd);
      else append(`${result.error}\n`);
    });
    return desktop.onTerminalEvent((id, event) => {
      if (id !== sessionId) return;
      if (event.type === 'output') return append(event.text);
      setRunning(false);
      setCwd(event.cwd);
      if (event.code !== 0) append(`[${event.code}]\n`);
    });
  }, [desktop, sessionId]);

  // Keeps the newest output in view.
  useEffect(() => {
    screen.current!.scrollTop = screen.current!.scrollHeight;
  }, [output]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const command = line;
    setLine('');
    append(`${cwd}> ${command}\n`);
    setRunning(true);
    void desktop.runInTerminal(sessionId, command).then((result) => {
      if (result.ok) return;
      append(`${result.error}\n`);
      setRunning(false);
    });
  };

  return (
    <ResizableBox
      aria-label={c.panels.terminal}
      fill
      labels={{ width: c.resizeBoxWidth, height: c.resizeBoxHeight, both: c.resizeBoxBoth }}
      className="flex flex-col rounded-lg border border-[var(--border)] bg-[var(--surface-1)]"
    >
      <h2 className="border-b border-[var(--border)] px-4 py-2 text-sm font-semibold">
        {c.panels.terminal}
      </h2>
      <pre
        ref={screen}
        role="log"
        aria-label={c.terminalOutput}
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words bg-[var(--surface-0)] p-3 font-mono text-xs"
      >
        {output}
      </pre>
      <form
        className="flex items-center gap-2 border-t border-[var(--border)] p-2"
        onSubmit={submit}
      >
        <span className="max-w-[40%] shrink-0 truncate font-mono text-xs text-[var(--text-muted)]">
          {`${cwd}>`}
        </span>
        <Input
          className="h-8 font-mono text-xs"
          aria-label={c.terminalCommand}
          placeholder={c.terminalPlaceholder}
          value={line}
          disabled={running}
          onChange={(event) => setLine(event.target.value)}
        />
        {running ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void desktop.stopTerminal(sessionId)}
          >
            {c.stopCommand}
          </Button>
        ) : (
          <Button type="submit" size="sm" disabled={!line.trim()}>
            {c.runCommand}
          </Button>
        )}
      </form>
    </ResizableBox>
  );
}
