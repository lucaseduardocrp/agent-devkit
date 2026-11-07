import { describe, expect, it, vi } from 'vitest';
import { PrismaNotificationOutbox } from '../src/modules/notifications/adapters/prisma-outbox.js';
import {
  NotificationChannelRegistry,
  type NotificationChannel,
} from '../src/modules/notifications/application/channel.js';
import {
  NotificationService,
  type RecipientDirectory,
} from '../src/modules/notifications/application/notification-service.js';
import {
  InMemoryNotificationOutbox,
  type NotificationOutbox,
  type PendingDelivery,
} from '../src/modules/notifications/application/outbox.js';
import { NotificationOutboxWorker } from '../src/modules/notifications/application/outbox-worker.js';
import { InMemoryNotificationRuleStore } from '../src/modules/notifications/application/rule-store.js';
import type { Recipient } from '../src/modules/notifications/domain/notification.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';

const WS = 'workspace-a';
const ANA: Recipient = { userId: 'ana', name: 'Ana', email: 'ana@example.com' };
const directory: RecipientDirectory = { find: async (_ws, id) => (id === 'ana' ? ANA : null) };
const pending = (patch: Partial<PendingDelivery> = {}): PendingDelivery => ({
  workspaceId: WS,
  channel: 'chat',
  recipient: ANA,
  message: { title: 'Hi', text: 'There' },
  ...patch,
});

/** A channel whose outcome each test decides, one send at a time. */
function channel(
  outcomes: ('ok' | 'fail')[] = [],
  options: { available?: boolean; id?: string } = {},
) {
  const sent: string[] = [];
  const impl: NotificationChannel = {
    id: options.id ?? 'chat',
    label: 'Chat',
    isAvailable: async () => options.available ?? true,
    send: async ({ message }) => {
      if ((outcomes.shift() ?? 'ok') === 'fail') throw new Error('boom');
      sent.push(message.text);
    },
  };
  return { impl, sent };
}

/** A clock the test moves by hand. */
function clock(start = new Date(Date.now() + 1_000)) {
  let at = start.getTime();
  return { now: () => new Date(at), advance: (ms: number) => void (at += ms) };
}

function worker(
  outbox: NotificationOutbox,
  channels: NotificationChannel[],
  options: Partial<ConstructorParameters<typeof NotificationOutboxWorker>[0]> = {},
) {
  const log = vi.fn();
  return {
    log,
    worker: new NotificationOutboxWorker({
      outbox,
      channels: new NotificationChannelRegistry(channels),
      log,
      ...options,
    }),
  };
}

describe('InMemoryNotificationOutbox', () => {
  it('hands out what is due, once, and counts the attempt', async () => {
    const outbox = new InMemoryNotificationOutbox();
    await outbox.enqueue([pending(), pending({ message: { title: 'B', text: 'b' } })]);
    const now = new Date(Date.now() + 1000);
    const first = await outbox.claimDue(now, 1, 60_000);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ attempts: 1, channel: 'chat', recipient: ANA });
    // What is held is not handed out again, until the hold runs out.
    expect(await outbox.claimDue(now, 5, 60_000)).toHaveLength(1);
    expect(await outbox.claimDue(now, 5, 60_000)).toHaveLength(0);
    const later = new Date(now.getTime() + 61_000);
    const taken = await outbox.claimDue(later, 5, 60_000);
    expect(taken.map((d) => d.attempts)).toEqual([2, 2]);
  });

  it('keeps what waits for its time, and forgets finished work after a while', async () => {
    const outbox = new InMemoryNotificationOutbox();
    await outbox.enqueue([pending(), pending(), pending()]);
    const now = new Date(Date.now() + 1000);
    const [a, b, c] = await outbox.claimDue(now, 5, 60_000);
    await outbox.markRetry(a!.id, new Date(now.getTime() + 30_000), 'later');
    await outbox.markSent(b!.id, now);
    await outbox.markFailed(c!.id, 'gave up');
    expect(await outbox.claimDue(now, 5, 60_000)).toEqual([]);
    expect(
      (await outbox.claimDue(new Date(now.getTime() + 31_000), 5, 60_000)).map((d) => d.id),
    ).toEqual([a!.id]);
    expect(
      outbox
        .snapshot()
        .map((e) => e.status)
        .sort(),
    ).toEqual(['failed', 'sending', 'sent']);

    expect(await outbox.purge(new Date(now.getTime() - 1000))).toBe(0);
    expect(await outbox.purge(new Date(now.getTime() + 1000))).toBe(2);
    expect(outbox.snapshot()).toHaveLength(1);
    // Marking something that is gone does nothing.
    await outbox.markSent('gone', now);
    await outbox.markRetry('gone', now, 'x');
    await outbox.markFailed('gone', 'x');
  });
});

describe('NotificationOutboxWorker', () => {
  it('delivers what is queued', async () => {
    const outbox = new InMemoryNotificationOutbox();
    const chat = channel();
    await outbox.enqueue([pending()]);
    const { worker: w } = worker(outbox, [chat.impl]);
    await w.runOnce();
    expect(chat.sent).toEqual(['There']);
    expect(outbox.snapshot()).toEqual([expect.objectContaining({ status: 'sent', attempts: 1 })]);
  });

  it('tries again after a wait that grows, then gives up', async () => {
    const outbox = new InMemoryNotificationOutbox();
    const time = clock();
    const chat = channel(['fail', 'fail', 'fail']);
    await outbox.enqueue([pending()]);
    const { worker: w, log } = worker(outbox, [chat.impl], {
      now: time.now,
      maxAttempts: 3,
      backoffMs: [1_000, 5_000],
    });

    time.advance(1);
    await w.runOnce();
    expect(outbox.snapshot()[0]).toMatchObject({ status: 'pending', attempts: 1, error: 'boom' });
    // Not yet: it waits its 1 s.
    await w.runOnce();
    expect(outbox.snapshot()[0]!.attempts).toBe(1);

    time.advance(1_000);
    await w.runOnce();
    expect(outbox.snapshot()[0]).toMatchObject({ status: 'pending', attempts: 2 });
    time.advance(4_999);
    await w.runOnce();
    expect(outbox.snapshot()[0]!.attempts).toBe(2);
    time.advance(1);
    await w.runOnce();
    expect(outbox.snapshot()[0]).toMatchObject({ status: 'failed', attempts: 3, error: 'boom' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('chat delivery'), expect.any(Error));
    expect(chat.sent).toEqual([]);
  });

  it('delivers on a later try once the channel works again', async () => {
    const outbox = new InMemoryNotificationOutbox();
    const time = clock();
    const chat = channel(['fail']);
    await outbox.enqueue([pending()]);
    const { worker: w } = worker(outbox, [chat.impl], { now: time.now });
    time.advance(1);
    await w.runOnce();
    time.advance(30_001);
    await w.runOnce();
    expect(chat.sent).toEqual(['There']);
    expect(outbox.snapshot()[0]).toMatchObject({ status: 'sent', attempts: 2, error: null });
  });

  it('gives up on a channel that no longer exists, and waits for one that is not set up', async () => {
    const outbox = new InMemoryNotificationOutbox();
    await outbox.enqueue([pending({ channel: 'ghost' }), pending({ channel: 'off' })]);
    const off = channel([], { available: false, id: 'off' });
    const { worker: w } = worker(outbox, [off.impl]);
    await w.runOnce();
    const by = (status: string) => outbox.snapshot().filter((e) => e.status === status);
    expect(by('failed')).toEqual([expect.objectContaining({ error: 'Unknown channel.' })]);
    expect(by('pending')).toEqual([
      expect.objectContaining({ error: 'The channel is not set up.' }),
    ]);
  });

  it('picks up, after a restart, what the old process left behind', async () => {
    const outbox = new InMemoryNotificationOutbox();
    const time = clock();
    const chat = channel();
    await outbox.enqueue([pending()]);
    // The first process took it and died before sending: the hold is all that is left.
    await outbox.claimDue(time.now(), 5, 60_000);
    expect(chat.sent).toEqual([]);

    const restarted = worker(outbox, [chat.impl], { now: time.now }).worker;
    await restarted.runOnce();
    expect(chat.sent).toEqual([]);
    time.advance(61_000);
    await restarted.runOnce();
    expect(chat.sent).toEqual(['There']);
    expect(outbox.snapshot()[0]).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('looks again at once when asked while it is busy, and never twice at the same time', async () => {
    const outbox = new InMemoryNotificationOutbox();
    const gate = { release: () => undefined as void };
    let sends = 0;
    const slow: NotificationChannel = {
      id: 'chat',
      label: 'Slow',
      isAvailable: async () => true,
      send: () => {
        sends += 1;
        return new Promise<void>((resolve) => (gate.release = resolve));
      },
    };
    await outbox.enqueue([pending()]);
    const { worker: w } = worker(outbox, [slow]);
    const first = w.runOnce();
    await vi.waitFor(() => expect(sends).toBe(1));
    await outbox.enqueue([pending({ message: { title: 'B', text: 'second' } })]);
    w.kick();
    expect(sends).toBe(1);
    gate.release();
    await first;
    await vi.waitFor(() => expect(sends).toBe(2));
    gate.release();
    await w.stop();
  });

  it('keeps looking on its own once started, and stops when told', async () => {
    vi.useFakeTimers();
    try {
      const outbox = new InMemoryNotificationOutbox();
      const chat = channel();
      const { worker: w } = worker(outbox, [chat.impl], { intervalMs: 1_000 });
      w.start();
      w.start();
      await vi.advanceTimersByTimeAsync(0);
      await outbox.enqueue([pending()]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(chat.sent).toEqual(['There']);
      await w.stop();
      await outbox.enqueue([pending({ message: { title: 'B', text: 'after stop' } })]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(chat.sent).toEqual(['There']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets old results at most once an hour', async () => {
    const outbox = new InMemoryNotificationOutbox();
    const purge = vi.spyOn(outbox, 'purge');
    const time = clock();
    const { worker: w } = worker(outbox, [channel().impl], { now: time.now, keepMs: 1_000 });
    time.advance(2 * 60 * 60_000);
    await w.runOnce();
    await w.runOnce();
    expect(purge).toHaveBeenCalledTimes(1);
    expect(purge.mock.calls[0]![0]).toEqual(new Date(time.now().getTime() - 1_000));
    time.advance(60 * 60_000);
    await w.runOnce();
    expect(purge).toHaveBeenCalledTimes(2);
  });

  it('never throws: an outbox that cannot be read, or an outcome it cannot record', async () => {
    const broken = new InMemoryNotificationOutbox();
    vi.spyOn(broken, 'claimDue').mockRejectedValue(new Error('db down'));
    const a = worker(broken, [channel().impl]);
    await expect(a.worker.runOnce()).resolves.toBeUndefined();
    expect(a.log).toHaveBeenCalledWith(
      '[Notifications] The delivery worker could not read the outbox:',
      expect.any(Error),
    );

    const outbox = new InMemoryNotificationOutbox();
    await outbox.enqueue([pending()]);
    vi.spyOn(outbox, 'markRetry').mockRejectedValue(new Error('db down'));
    const b = worker(outbox, [channel(['fail']).impl]);
    await b.worker.runOnce();
    expect(b.log).toHaveBeenCalledWith(
      '[Notifications] Could not record the outcome of a delivery:',
      expect.any(Error),
    );
  });

  it('describes a failure that is not an Error, and logs to the console by default', async () => {
    const outbox = new InMemoryNotificationOutbox();
    await outbox.enqueue([pending()]);
    const odd: NotificationChannel = {
      id: 'chat',
      label: 'Odd',
      isAvailable: async () => true,
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      send: () => Promise.reject('nope'),
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await new NotificationOutboxWorker({
      outbox,
      channels: new NotificationChannelRegistry([odd]),
    }).runOnce();
    expect(outbox.snapshot()[0]).toMatchObject({ status: 'pending', error: 'Delivery failed.' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('NotificationService with an outbox', () => {
  function setup(
    options: {
      outbox?: InMemoryNotificationOutbox;
      onQueued?: () => void;
      available?: boolean;
    } = {},
  ) {
    const outbox = options.outbox ?? new InMemoryNotificationOutbox();
    const chat = channel([], { available: options.available ?? true });
    const log = vi.fn();
    const service = new NotificationService({
      channels: new NotificationChannelRegistry([chat.impl]),
      rules: new InMemoryNotificationRuleStore(),
      directory,
      outbox,
      onQueued: options.onQueued,
      log,
    });
    return { outbox, chat, service, log };
  }
  const message = {
    workspaceId: WS,
    userIds: ['ana'],
    channels: ['chat'],
    subject: 'Hi',
    message: 'There',
  };

  it('saves the delivery instead of sending it, and tells the worker', async () => {
    const onQueued = vi.fn();
    const { outbox, chat, service } = setup({ onQueued });
    expect(await service.send(message)).toEqual([
      { channel: 'chat', userId: 'ana', status: 'queued' },
    ]);
    expect(chat.sent).toEqual([]);
    expect(outbox.snapshot()).toEqual([expect.objectContaining({ status: 'pending' })]);
    expect(onQueued).toHaveBeenCalledOnce();
  });

  it('is delivered even if the process that queued it is gone, by the next worker', async () => {
    const { outbox, chat, service } = setup();
    await service.send(message);
    // A new process starts with nothing but the outbox.
    await worker(outbox, [chat.impl]).worker.runOnce();
    expect(chat.sent).toEqual(['There']);
  });

  it('does not queue what cannot be delivered anyway', async () => {
    const { outbox, service } = setup({ available: false });
    const results = await service.send({
      ...message,
      userIds: ['ana', 'stranger'],
      channels: ['chat', 'ghost'],
    });
    expect(results.map((r) => r.status)).toEqual(['skipped', 'skipped', 'skipped', 'skipped']);
    expect(outbox.snapshot()).toEqual([]);
  });

  it('sends on the spot when asked to, to see whether a channel works', async () => {
    const { outbox, chat, service } = setup();
    expect(await service.send({ ...message, immediate: true })).toEqual([
      { channel: 'chat', userId: 'ana', status: 'sent' },
    ]);
    expect(chat.sent).toEqual(['There']);
    expect(outbox.snapshot()).toEqual([]);
  });

  it('says so when the delivery could not be saved, and does not tell the worker', async () => {
    const outbox = new InMemoryNotificationOutbox();
    vi.spyOn(outbox, 'enqueue').mockRejectedValue(new Error('db down'));
    const onQueued = vi.fn();
    const { service, log } = setup({ outbox, onQueued });
    const results = await service.send({ ...message, userIds: ['ana', 'stranger'] });
    expect(results).toEqual([
      { channel: 'chat', userId: 'ana', status: 'failed', reason: 'Could not be queued.' },
      {
        channel: 'chat',
        userId: 'stranger',
        status: 'skipped',
        reason: 'Not a member of the workspace.',
      },
    ]);
    expect(onQueued).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      '[Notifications] Could not queue the deliveries:',
      expect.any(Error),
    );
  });

  it('queues without a worker to wake', async () => {
    const { outbox, service } = setup();
    await service.send(message);
    expect(outbox.snapshot()).toHaveLength(1);
  });
});

describe('PrismaNotificationOutbox', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const row = (patch: Record<string, unknown> = {}) => ({
    id: 'd1',
    workspaceId: WS,
    channel: 'chat',
    attempts: 1,
    recipient: ANA,
    message: { title: 'Hi', text: 'There' },
    ...patch,
  });

  function setup() {
    const record = {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 3 }),
    };
    return {
      record,
      outbox: new PrismaNotificationOutbox({
        notificationDeliveryRecord: record,
      } as unknown as PrismaClient),
    };
  }

  it('writes the deliveries in one go, and nothing when there are none', async () => {
    const { record, outbox } = setup();
    await outbox.enqueue([]);
    expect(record.createMany).not.toHaveBeenCalled();
    await outbox.enqueue([pending(), pending({ channel: 'mail' })]);
    expect(record.createMany).toHaveBeenCalledWith({
      data: [
        {
          workspaceId: WS,
          channel: 'chat',
          recipient: ANA,
          message: { title: 'Hi', text: 'There' },
        },
        {
          workspaceId: WS,
          channel: 'mail',
          recipient: ANA,
          message: { title: 'Hi', text: 'There' },
        },
      ],
    });
  });

  it('takes what is due and returns only what this worker got', async () => {
    const { record, outbox } = setup();
    record.findMany
      .mockResolvedValueOnce([{ id: 'd1' }, { id: 'd2' }])
      .mockResolvedValueOnce([row()]);
    const claimed = await outbox.claimDue(now, 10, 60_000);

    expect(record.findMany.mock.calls[0]![0]).toMatchObject({
      take: 10,
      orderBy: { nextAttemptAt: 'asc' },
    });
    const update = record.updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    // Rows are re-checked as they are taken, so another worker cannot get the same one.
    expect(update.where).toMatchObject({ id: { in: ['d1', 'd2'] }, OR: expect.any(Array) });
    expect(update.data).toMatchObject({
      status: 'sending',
      attempts: { increment: 1 },
      claimedUntil: new Date(now.getTime() + 60_000),
    });
    const token = update.data['claimToken'] as string;
    expect(record.findMany.mock.calls[1]![0]).toEqual({
      where: { claimToken: token, status: 'sending' },
    });
    expect(claimed).toEqual([
      {
        id: 'd1',
        workspaceId: WS,
        channel: 'chat',
        attempts: 1,
        recipient: ANA,
        message: { title: 'Hi', text: 'There' },
      },
    ]);
  });

  it('does nothing when nothing is due', async () => {
    const { record, outbox } = setup();
    record.findMany.mockResolvedValueOnce([]);
    expect(await outbox.claimDue(now, 10, 60_000)).toEqual([]);
    expect(record.updateMany).not.toHaveBeenCalled();
  });

  it('records how a delivery ended', async () => {
    const { record, outbox } = setup();
    await outbox.markSent('d1', now);
    await outbox.markRetry('d1', now, 'later');
    await outbox.markFailed('d1', 'gave up');
    const data = record.updateMany.mock.calls.map(
      (call) => (call[0] as { data: Record<string, unknown> }).data,
    );
    expect(data[0]).toMatchObject({ status: 'sent', sentAt: now, lastError: null });
    expect(data[1]).toMatchObject({
      status: 'pending',
      nextAttemptAt: now,
      lastError: 'later',
      claimToken: null,
    });
    expect(data[2]).toMatchObject({ status: 'failed', lastError: 'gave up', claimedUntil: null });
  });

  it('forgets old results', async () => {
    const { record, outbox } = setup();
    expect(await outbox.purge(now)).toBe(3);
    expect(record.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { status: 'sent', sentAt: { lt: now } },
          { status: 'failed', createdAt: { lt: now } },
        ],
      },
    });
  });
});
