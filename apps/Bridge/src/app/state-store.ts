import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Autonomy } from '../core/types.js';

/** What the bridge remembers about one conversation. */
export interface ChatState {
  cli?: string;
  mode?: Autonomy;
  /** The CLIs' own conversation ids, so `/new` and switching CLIs keep them apart. */
  sessions: Record<string, string>;
}

export type Schedule =
  | { readonly kind: 'every'; readonly ms: number }
  | { readonly kind: 'daily'; readonly hour: number; readonly minute: number };

/** A prompt the bridge runs by itself, on a schedule, and reports to its chat. */
export interface ScheduledTask {
  readonly id: number;
  readonly chatKey: string;
  /** Whose credentials and files the task runs with. */
  readonly identity: string;
  readonly chatId: string;
  readonly channel: string;
  readonly cli: string;
  readonly mode: Autonomy;
  readonly prompt: string;
  readonly schedule: Schedule;
  nextRunAt: number;
  lastRunAt?: number;
  lastStatus?: 'ok' | 'error';
}

interface StateFile {
  chats: Record<string, ChatState>;
  tasks: ScheduledTask[];
  nextTaskId: number;
}

/** Persists chats and scheduled tasks in one JSON file, written atomically. */
export class StateStore {
  private state: StateFile = { chats: {}, tasks: [], nextTaskId: 1 };

  /** `file` null keeps everything in memory (tests). */
  constructor(private readonly file: string | null) {
    if (!file) return;
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<StateFile>;
      this.state = {
        chats: saved.chats ?? {},
        tasks: saved.tasks ?? [],
        nextTaskId: saved.nextTaskId ?? 1,
      };
    } catch {
      // First start, or an unreadable file: begin empty rather than refuse to run.
    }
  }

  chat(key: string): ChatState {
    return (this.state.chats[key] ??= { sessions: {} });
  }

  updateChat(key: string, change: (chat: ChatState) => void): void {
    change(this.chat(key));
    this.save();
  }

  tasks(): readonly ScheduledTask[] {
    return this.state.tasks;
  }

  addTask(task: Omit<ScheduledTask, 'id'>): ScheduledTask {
    const created = { ...task, id: this.state.nextTaskId++ };
    this.state.tasks.push(created);
    this.save();
    return created;
  }

  removeTask(id: number, chatKey: string): boolean {
    const before = this.state.tasks.length;
    this.state.tasks = this.state.tasks.filter((t) => !(t.id === id && t.chatKey === chatKey));
    this.save();
    return this.state.tasks.length < before;
  }

  save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state, null, 2));
    renameSync(temp, this.file);
  }
}
