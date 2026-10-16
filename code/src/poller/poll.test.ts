import {
  type PollDeps,
  type QualifiedMessage,
  parseChannelAllowlist,
  qualifies,
  RECEIPT_LEASE_MS,
  type SlackHistoryMessage,
  type SlackPollClient,
  SlackPoller,
  THREAD_DISCOVERY_SECONDS,
  THREAD_WATCH_SECONDS,
  toEventPayload,
  toSlackTs,
} from './poll';
import {
  type ClaimResult,
  channelKey,
  globalKey,
  type Receipt,
  receiptKey,
  type StateRecord,
  type StateStore,
  threadKey,
} from './state';

const BOT = 'UBOT';
const MENTION = `<@${BOT}>`;
const T0 = 1_790_000_000_000; // ms
const BOT_USERS = new Set([BOT, 'U9', 'UOTHERBOT']);

/** In-memory store that enforces unique keys the same way custom-objects.create does. */
class MemoryStore implements StateStore {
  states = new Map<string, StateRecord>();
  receipts = new Map<string, Receipt & { key: string }>();
  private nextId = 1;
  failNextComplete = false;

  payloads = new Map<string, unknown>();

  async claimReceipt(
    channel: string,
    messageTs: string,
    _threadTs: string,
    now: number,
    payload?: unknown
  ): Promise<ClaimResult> {
    const key = receiptKey('inst-1', channel, messageTs);
    if (payload && !this.receipts.has(key)) this.payloads.set(key, payload);
    const existing = this.receipts.get(key);
    if (existing) return { claimed: false, existing: { ...existing } };
    const receipt = { claimedAt: now, id: `r${this.nextId++}`, key, status: 'claimed' as const };
    this.receipts.set(key, receipt);
    return { claimed: true, receipt: { ...receipt } };
  }

  private byId(id: string) {
    const found = [...this.receipts.values()].find((r) => r.id === id);
    if (!found) throw new Error(`no receipt ${id}`);
    return found;
  }

  async completeReceipt(receipt: Receipt): Promise<void> {
    if (this.failNextComplete) {
      this.failNextComplete = false;
      throw new Error('simulated crash before receipt completion');
    }
    this.byId(receipt.id).status = 'done';
  }

  async reclaimReceipt(receipt: Receipt, now: number): Promise<Receipt> {
    const r = this.byId(receipt.id);
    r.claimedAt = now;
    r.status = 'claimed';
    return { ...r };
  }

  async recordReceiptDm(receipt: Receipt, dmObject: string): Promise<void> {
    this.byId(receipt.id).dmObject = dmObject;
  }

  async deleteState(record: StateRecord): Promise<void> {
    this.states.delete(record.uniqueKey);
  }

  async getState(uniqueKey: string): Promise<StateRecord | undefined> {
    const s = this.states.get(uniqueKey);
    return s ? { ...s } : undefined;
  }

  async listState(): Promise<StateRecord[]> {
    return [...this.states.values()].map((s) => ({ ...s }));
  }

  async saveState(record: Omit<StateRecord, 'id'> & { id?: string }): Promise<StateRecord> {
    const existing = this.states.get(record.uniqueKey);
    const saved = { ...record, id: record.id ?? existing?.id ?? `s${this.nextId++}` } as StateRecord;
    this.states.set(record.uniqueKey, saved);
    return { ...saved };
  }
}

interface FakeChannel {
  id: string;
  messages: SlackHistoryMessage[];
  replies?: Record<string, SlackHistoryMessage[]>;
  type: 'im' | 'public_channel' | 'private_channel' | 'mpim';
}

const createSlack = (channels: FakeChannel[], missingScopeTypes: string[] = []) => {
  const conversations = jest.fn(async ({ types }: { types: string }) => {
    if (missingScopeTypes.includes(types)) {
      throw Object.assign(new Error('An API error occurred: missing_scope'), {
        data: { error: 'missing_scope', needed: `${types === 'im' ? 'im' : 'channels'}:read` },
      });
    }
    return {
      channels: channels.filter((c) => c.type === types).map((c) => ({ id: c.id, is_im: c.type === 'im' })),
      response_metadata: { scopes: ['channels:read', 'chat:write'] },
    };
  });
  const history = jest.fn(async ({ channel, oldest }: { channel: string; oldest: string }) => ({
    // Slack returns newest first.
    messages: (channels.find((c) => c.id === channel)?.messages ?? [])
      .filter((m) => Number(m.ts) > Number(oldest))
      .slice()
      .reverse(),
    response_metadata: {},
  }));
  const replies = jest.fn(async ({ channel, oldest, ts }: { channel: string; oldest: string; ts: string }) => {
    const root = channels.find((c) => c.id === channel)?.messages.find((m) => m.ts === ts);
    const threadReplies = channels.find((c) => c.id === channel)?.replies?.[ts] ?? [];
    return {
      messages: [...(root ? [root] : []), ...threadReplies.filter((m) => Number(m.ts) > Number(oldest))],
      response_metadata: {},
    };
  });
  const info = jest.fn(async ({ user }: { user: string }) => ({ user: { id: user, is_bot: BOT_USERS.has(user) } }));
  const slack = { conversations: { history, replies }, users: { conversations, info } } as unknown as SlackPollClient;
  return { history, replies, slack, usersConversations: conversations, usersInfo: info };
};

const ts = (offsetSeconds: number): string => toSlackTs(T0 + offsetSeconds * 1000);

const setup = (channels: FakeChannel[], opts: { missingScopeTypes?: string[]; store?: MemoryStore } = {}) => {
  const store = opts.store ?? new MemoryStore();
  const clock = { now: T0 };
  const dispatched: QualifiedMessage[] = [];
  const postedRefs = new Set<string>();
  const dispatch = jest.fn(async (message: QualifiedMessage, onDmResolved: (dm: string) => Promise<void>) => {
    await onDmResolved(`dm-${message.channel}-${message.threadTs}`);
    postedRefs.add(`${message.channel}:${message.ts}`);
    dispatched.push(message);
  });
  const isDispatched = jest.fn(async (_dm: string, channel: string, messageTs: string) =>
    postedRefs.has(`${channel}:${messageTs}`)
  );
  const fake = createSlack(channels, opts.missingScopeTypes);
  const deps: PollDeps = {
    botUserId: BOT,
    dispatch,
    installId: 'inst-1',
    isDispatched,
    log: () => undefined,
    now: () => clock.now,
    slack: fake.slack,
    store,
  };
  return {
    clock,
    deps,
    dispatch,
    dispatched,
    fake,
    isDispatched,
    poller: () => new SlackPoller(deps),
    postedRefs,
    store,
  };
};

describe('qualifies', () => {
  it('accepts any human DM with text', () => {
    expect(qualifies({ text: 'run login tests', ts: '1.1', user: 'U1' }, true, BOT)).toBe(true);
  });

  it('requires a bot mention with a prompt in channels', () => {
    expect(qualifies({ text: 'hello team', ts: '1.1', user: 'U1' }, false, BOT)).toBe(false);
    expect(qualifies({ text: MENTION, ts: '1.1', user: 'U1' }, false, BOT)).toBe(false);
    expect(qualifies({ text: `${MENTION} run checkout`, ts: '1.1', user: 'U1' }, false, BOT)).toBe(true);
  });

  it('skips the bot itself and system subtypes, and leaves bot_id authors to the poller', () => {
    expect(qualifies({ bot_id: 'B1', text: 'hi', ts: '1.1', user: 'U1' }, true, BOT)).toBe(true);
    expect(qualifies({ bot_id: 'B1', text: 'hi', ts: '1.1' }, true, BOT)).toBe(false);
    expect(qualifies({ text: 'hi', ts: '1.1', user: BOT }, true, BOT)).toBe(false);
    expect(qualifies({ subtype: 'channel_join', text: 'joined', ts: '1.1', user: 'U1' }, true, BOT)).toBe(false);
    expect(qualifies({ subtype: 'file_share', text: 'see file', ts: '1.1', user: 'U1' }, true, BOT)).toBe(true);
  });
});

describe('toEventPayload', () => {
  it('produces payloads that the existing DM and mention parsers accept', () => {
    const dm = toEventPayload({
      channel: 'D1',
      isIm: true,
      message: { text: 'hi', ts: '1.1', user: 'U1' },
      threadTs: '1.1',
      ts: '1.1',
    });
    expect(dm).toMatchObject({ event: { channel: 'D1', channel_type: 'im', type: 'message' } });

    const mention = toEventPayload({
      channel: 'C1',
      isIm: false,
      message: { subtype: 'thread_broadcast', text: `${MENTION} go`, thread_ts: '1.0', ts: '1.1', user: 'U1' },
      threadTs: '1.0',
      ts: '1.1',
    });
    expect(mention).toMatchObject({ event: { channel: 'C1', thread_ts: '1.0', type: 'app_mention' } });
    expect((mention['event'] as Record<string, unknown>)['subtype']).toBeUndefined();
  });
});

describe('SlackPoller.tick', () => {
  it('initializes cursors to now on first run and does not backfill history', async () => {
    const env = setup([
      { id: 'D1', messages: [{ text: 'old DM', ts: ts(-3600), user: 'U1' }], type: 'im' },
      { id: 'C1', messages: [{ text: `${MENTION} old`, ts: ts(-60), user: 'U1' }], type: 'public_channel' },
    ]);

    const summary = await env.poller().tick();

    expect(summary.firstRun).toBe(true);
    expect(env.dispatch).not.toHaveBeenCalled();
    expect(env.store.states.get(globalKey('inst-1'))?.lastTs).toBe(ts(0));
    expect(env.store.states.get(channelKey('inst-1', 'D1'))?.lastTs).toBe(ts(0));
    expect(env.store.states.get(channelKey('inst-1', 'C1'))?.lastTs).toBe(ts(0));
  });

  it('dispatches qualifying messages in ts order and advances each channel cursor', async () => {
    const channels: FakeChannel[] = [
      { id: 'D1', messages: [], type: 'im' },
      { id: 'C1', messages: [], type: 'public_channel' },
    ];
    const env = setup(channels);
    await env.poller().tick();

    channels[0]!.messages.push(
      { text: 'first', ts: ts(10), user: 'U1' },
      { bot_id: 'B1', text: 'bot noise', ts: ts(11), user: 'U9' },
      { text: 'second', ts: ts(12), user: 'U1' }
    );
    channels[1]!.messages.push(
      { text: 'no mention', ts: ts(13), user: 'U2' },
      { text: `${MENTION} run checkout`, ts: ts(14), user: 'U2' }
    );
    env.clock.now = T0 + 60_000;
    const summary = await env.poller().tick();

    expect(env.dispatched.map((m) => `${m.channel}:${m.ts}`)).toEqual([`D1:${ts(10)}`, `D1:${ts(12)}`, `C1:${ts(14)}`]);
    expect(summary.dispatched).toBe(3);
    expect(env.store.states.get(channelKey('inst-1', 'D1'))?.lastTs).toBe(ts(12));
    expect(env.store.states.get(channelKey('inst-1', 'C1'))?.lastTs).toBe(ts(14));
    expect(env.fake.history).toHaveBeenCalledWith(expect.objectContaining({ channel: 'D1', oldest: ts(0) }));
  });

  it('dispatches a human posting through an app token and skips bot authors, looking each user up once', async () => {
    const channels: FakeChannel[] = [{ id: 'C1', messages: [], type: 'public_channel' }];
    const env = setup(channels);
    await env.poller().tick();

    channels[0]!.messages.push(
      { bot_id: 'BAPP', text: `${MENTION} from a person via an app`, ts: ts(10), user: 'U1' },
      { bot_id: 'BOTHER', text: `${MENTION} from another bot`, ts: ts(11), user: 'UOTHERBOT' },
      { bot_id: 'BAPP', text: `${MENTION} again`, ts: ts(12), user: 'U1' }
    );
    env.clock.now = T0 + 60_000;
    await env.poller().tick();

    expect(env.dispatched.map((m) => m.ts)).toEqual([ts(10), ts(12)]);
    expect(env.fake.usersInfo).toHaveBeenCalledTimes(2);
    const payload = toEventPayload(env.dispatched[0]!);
    expect((payload['event'] as Record<string, unknown>)['bot_id']).toBeUndefined();
    expect(env.store.states.get(channelKey('inst-1', 'C1'))?.lastTs).toBe(ts(12));
  });

  it('retries a bot_id message after a failed author lookup without redispatching earlier ones', async () => {
    const channels: FakeChannel[] = [{ id: 'C1', messages: [], type: 'public_channel' }];
    const env = setup(channels);
    await env.poller().tick();

    channels[0]!.messages.push(
      { text: `${MENTION} first`, ts: ts(10), user: 'U1' },
      { bot_id: 'BAPP', text: `${MENTION} second`, ts: ts(11), user: 'U2' }
    );
    env.fake.usersInfo.mockRejectedValueOnce(new Error('ratelimited'));
    env.clock.now = T0 + 60_000;
    const summary = await env.poller().tick();

    expect(env.dispatched.map((m) => m.ts)).toEqual([ts(10)]);
    expect(summary.errors).toHaveLength(1);
    expect(Number(env.store.states.get(channelKey('inst-1', 'C1'))?.lastTs)).toBeLessThan(Number(ts(11)));

    env.clock.now = T0 + 120_000;
    const retry = await env.poller().tick();
    expect(env.dispatched.map((m) => m.ts)).toEqual([ts(10), ts(11)]);
    expect(retry.duplicatesSkipped).toBe(1);
  });

  it('never dispatches the same message twice across repeated ticks', async () => {
    const channels: FakeChannel[] = [{ id: 'D1', messages: [], type: 'im' }];
    const env = setup(channels);
    await env.poller().tick();
    channels[0]!.messages.push({ text: 'run it', ts: ts(5), user: 'U1' });

    env.clock.now = T0 + 60_000;
    await env.poller().tick();
    env.clock.now = T0 + 120_000;
    await env.poller().tick();

    expect(env.dispatch).toHaveBeenCalledTimes(1);
  });

  it('treats two identical texts as two distinct messages because each has its own ts', async () => {
    const channels: FakeChannel[] = [{ id: 'D1', messages: [], type: 'im' }];
    const env = setup(channels);
    await env.poller().tick();
    channels[0]!.messages.push({ text: 'same', ts: ts(5), user: 'U1' }, { text: 'same', ts: ts(6), user: 'U1' });

    env.clock.now = T0 + 60_000;
    await env.poller().tick();

    expect(env.dispatch).toHaveBeenCalledTimes(2);
  });

  it('skips a message whose receipt is done even if the cursor write was lost (crash after dispatch)', async () => {
    const channels: FakeChannel[] = [{ id: 'D1', messages: [], type: 'im' }];
    const env = setup(channels);
    await env.poller().tick();
    channels[0]!.messages.push({ text: 'run it', ts: ts(5), user: 'U1' });
    env.clock.now = T0 + 60_000;
    await env.poller().tick();

    // Simulate the cursor write never landing.
    env.store.states.set(channelKey('inst-1', 'D1'), {
      ...env.store.states.get(channelKey('inst-1', 'D1'))!,
      lastTs: ts(0),
    });
    env.clock.now = T0 + 120_000;
    const summary = await env.poller().tick();

    expect(env.dispatch).toHaveBeenCalledTimes(1);
    expect(summary.duplicatesSkipped).toBe(1);
    expect(env.store.states.get(channelKey('inst-1', 'D1'))?.lastTs).toBe(ts(5));
  });

  it('does not re-dispatch when the process died after posting but before completing the receipt', async () => {
    const channels: FakeChannel[] = [{ id: 'D1', messages: [], type: 'im' }];
    const env = setup(channels);
    await env.poller().tick();
    channels[0]!.messages.push({ text: 'run it', ts: ts(5), user: 'U1' });

    env.store.failNextComplete = true;
    env.clock.now = T0 + 60_000;
    await env.poller().tick();
    expect(env.dispatch).toHaveBeenCalledTimes(1);
    expect(env.store.states.get(channelKey('inst-1', 'D1'))?.lastTs).toBe(ts(0));

    // Within the lease the message is held (not skipped, not re-run).
    env.clock.now = T0 + 120_000;
    const held = await env.poller().tick();
    expect(held.inFlight).toBe(1);
    expect(env.dispatch).toHaveBeenCalledTimes(1);

    // After the lease, the executing comment is found in the recorded DM, so the receipt is completed without re-dispatch.
    env.clock.now = T0 + 60_000 + RECEIPT_LEASE_MS + 1;
    const recovered = await env.poller().tick();
    expect(env.isDispatched).toHaveBeenCalledWith(`dm-D1-${ts(5)}`, 'D1', ts(5));
    expect(recovered.duplicatesSkipped).toBe(1);
    expect(env.dispatch).toHaveBeenCalledTimes(1);
    expect(env.store.states.get(channelKey('inst-1', 'D1'))?.lastTs).toBe(ts(5));
  });

  it('retries a message whose dispatch was interrupted before the executing comment was posted', async () => {
    const channels: FakeChannel[] = [{ id: 'D1', messages: [], type: 'im' }];
    const env = setup(channels);
    await env.poller().tick();
    channels[0]!.messages.push({ text: 'run it', ts: ts(5), user: 'U1' }, { text: 'later', ts: ts(6), user: 'U1' });

    env.dispatch.mockImplementationOnce(async () => {
      throw new Error('simulated crash mid-dispatch');
    });
    env.clock.now = T0 + 60_000;
    await env.poller().tick();
    // The failing message blocks the cursor, so the later message is not processed out of order.
    expect(env.dispatched).toHaveLength(0);
    expect(env.store.states.get(channelKey('inst-1', 'D1'))?.lastTs).toBe(ts(0));

    env.clock.now = T0 + 60_000 + RECEIPT_LEASE_MS + 1;
    await env.poller().tick();
    expect(env.dispatched.map((m) => m.ts)).toEqual([ts(5), ts(6)]);
    expect(env.store.states.get(channelKey('inst-1', 'D1'))?.lastTs).toBe(ts(6));
  });

  it('starts a newly joined channel shortly before the previous tick instead of backfilling', async () => {
    const channels: FakeChannel[] = [{ id: 'D1', messages: [], type: 'im' }];
    const env = setup(channels);
    await env.poller().tick();

    channels.push({
      id: 'C2',
      messages: [
        { text: `${MENTION} ancient`, ts: ts(-1000), user: 'U1' },
        { text: `${MENTION} fresh`, ts: ts(30), user: 'U1' },
      ],
      type: 'private_channel',
    });
    env.clock.now = T0 + 60_000;
    await env.poller().tick();

    // History reaches back for thread discovery, but only messages after the new-channel cursor are dispatched.
    expect(env.fake.history).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C2', oldest: toSlackTs(T0 + 60_000 - THREAD_DISCOVERY_SECONDS * 1000) })
    );
    expect(env.dispatched.map((m) => m.ts)).toEqual([ts(30)]);
    expect(env.store.states.get(channelKey('inst-1', 'C2'))?.lastTs).toBe(ts(30));
  });

  describe('shared threads', () => {
    const OTHER_BOT = 'UOTHERBOT';
    const ROOT = ts(-3000);
    const reply = (message: SlackHistoryMessage): SlackHistoryMessage => ({ ...message, thread_ts: ROOT });
    const sharedThread = (replies: SlackHistoryMessage[]): FakeChannel => ({
      id: 'C1',
      messages: [
        {
          latest_reply: replies.at(-1)?.ts,
          reply_count: replies.length,
          text: `<@${OTHER_BOT}> hello`,
          ts: ROOT,
          user: 'U1',
        },
      ],
      replies: { [ROOT]: replies },
      type: 'public_channel',
    });
    const addReplies = (channel: FakeChannel, ...messages: SlackHistoryMessage[]) => {
      channel.replies![ROOT]!.push(...messages.map(reply));
      channel.messages[0]!.reply_count = channel.replies![ROOT]!.length;
      channel.messages[0]!.latest_reply = messages.at(-1)?.ts;
    };
    const otherBotReply = reply({ bot_id: 'BOTHER', text: 'other bot here', ts: ts(-2990), user: OTHER_BOT });

    it('joins a thread another bot started when a new reply @mentions it, exactly once', async () => {
      const channel = sharedThread([otherBotReply]);
      const env = setup([channel]);
      await env.poller().tick();

      addReplies(channel, { text: `${MENTION} join in`, ts: ts(20), user: 'U2' });
      env.clock.now = T0 + 60_000;
      await env.poller().tick();

      expect(env.dispatched.map((m) => `${m.ts}@${m.threadTs}`)).toEqual([`${ts(20)}@${ROOT}`]);
      expect(env.store.states.get(threadKey('inst-1', 'C1', ROOT))?.lastTs).toBe(ts(20));

      addReplies(channel, { text: 'thanks both', ts: ts(70), user: 'U2' });
      env.clock.now = T0 + 120_000;
      await env.poller().tick();
      env.clock.now = T0 + 180_000;
      await env.poller().tick();

      expect(env.dispatch).toHaveBeenCalledTimes(1);
    });

    it('does not watch a thread whose new replies do not mention it, or mention it only from a bot', async () => {
      const channel = sharedThread([otherBotReply]);
      const env = setup([channel]);
      await env.poller().tick();

      addReplies(
        channel,
        { text: `<@${OTHER_BOT}> only you`, ts: ts(20), user: 'U2' },
        { bot_id: 'BOTHER', text: `${MENTION} handing over`, ts: ts(21), user: OTHER_BOT }
      );
      env.clock.now = T0 + 60_000;
      await env.poller().tick();

      expect(env.dispatch).not.toHaveBeenCalled();
      expect(env.store.states.has(threadKey('inst-1', 'C1', ROOT))).toBe(false);
    });

    it('does not backfill thread mentions on the first run', async () => {
      const env = setup([
        sharedThread([otherBotReply, reply({ text: `${MENTION} old ask`, ts: ts(-10), user: 'U2' })]),
      ]);
      await env.poller().tick();
      expect(env.dispatch).not.toHaveBeenCalled();
    });

    it('follows its own thread after a mention of both bots without starting a second watch', async () => {
      const channel: FakeChannel = { id: 'C1', messages: [], replies: {}, type: 'public_channel' };
      const env = setup([channel]);
      await env.poller().tick();

      channel.messages.push({ text: `${MENTION} <@${OTHER_BOT}> both of you`, ts: ts(10), user: 'U1' });
      env.clock.now = T0 + 60_000;
      await env.poller().tick();
      channel.messages[0]!.reply_count = 1;
      channel.messages[0]!.latest_reply = ts(65);
      channel.replies![ts(10)] = [{ text: `${MENTION} and again`, thread_ts: ts(10), ts: ts(65), user: 'U1' }];
      env.clock.now = T0 + 120_000;
      await env.poller().tick();
      env.clock.now = T0 + 180_000;
      await env.poller().tick();

      expect(env.dispatched.map((m) => `${m.ts}@${m.threadTs}`)).toEqual([
        `${ts(10)}@${ts(10)}`,
        `${ts(65)}@${ts(10)}`,
      ]);
      expect([...env.store.states.keys()].filter((k) => k === threadKey('inst-1', 'C1', ts(10)))).toHaveLength(1);
    });
  });

  it('watches the thread after a dispatch and picks up DM follow-ups exactly once', async () => {
    const channels: FakeChannel[] = [{ id: 'D1', messages: [], replies: {}, type: 'im' }];
    const env = setup(channels);
    await env.poller().tick();
    channels[0]!.messages.push({ text: 'start', ts: ts(5), user: 'U1' });
    env.clock.now = T0 + 60_000;
    await env.poller().tick();

    const watch = env.store.states.get(threadKey('inst-1', 'D1', ts(5)));
    expect(watch?.lastTs).toBe(ts(5));
    expect(Number(watch?.activeUntil)).toBe(Math.floor((T0 + 60_000) / 1000) + THREAD_WATCH_SECONDS);

    channels[0]!.replies![ts(5)] = [
      { bot_id: 'B1', text: 'agent reply', thread_ts: ts(5), ts: ts(70), user: BOT },
      { text: 'follow up', thread_ts: ts(5), ts: ts(80), user: 'U1' },
    ];
    env.clock.now = T0 + 120_000;
    await env.poller().tick();
    env.clock.now = T0 + 180_000;
    await env.poller().tick();

    expect(env.dispatched.map((m) => `${m.ts}@${m.threadTs}`)).toEqual([`${ts(5)}@${ts(5)}`, `${ts(80)}@${ts(5)}`]);
    expect(env.store.states.get(threadKey('inst-1', 'D1', ts(5)))?.lastTs).toBe(ts(80));
  });

  it('only dispatches channel thread replies that mention the bot', async () => {
    const channels: FakeChannel[] = [{ id: 'C1', messages: [], replies: {}, type: 'public_channel' }];
    const env = setup(channels);
    await env.poller().tick();
    channels[0]!.messages.push({ text: `${MENTION} start`, ts: ts(5), user: 'U1' });
    env.clock.now = T0 + 60_000;
    await env.poller().tick();

    channels[0]!.replies![ts(5)] = [
      { text: 'chatter', thread_ts: ts(5), ts: ts(70), user: 'U2' },
      { text: `${MENTION} again`, thread_ts: ts(5), ts: ts(80), user: 'U2' },
    ];
    env.clock.now = T0 + 120_000;
    await env.poller().tick();

    expect(env.dispatched.map((m) => m.ts)).toEqual([ts(5), ts(80)]);
  });

  it('does not double-dispatch a broadcast reply seen by both history and the thread watch', async () => {
    const channels: FakeChannel[] = [{ id: 'D1', messages: [], replies: {}, type: 'im' }];
    const env = setup(channels);
    await env.poller().tick();
    channels[0]!.messages.push({ text: 'start', ts: ts(5), user: 'U1' });
    env.clock.now = T0 + 60_000;
    await env.poller().tick();

    const broadcast = { subtype: 'thread_broadcast', text: 'also here', thread_ts: ts(5), ts: ts(70), user: 'U1' };
    channels[0]!.messages.push(broadcast);
    channels[0]!.replies![ts(5)] = [broadcast];
    env.clock.now = T0 + 120_000;
    await env.poller().tick();

    expect(env.dispatched.map((m) => m.ts)).toEqual([ts(5), ts(70)]);
  });

  it('expires thread watches after the watch window', async () => {
    const env = setup([{ id: 'D1', messages: [], type: 'im' }]);
    await env.poller().tick();
    env.store.states.set(threadKey('inst-1', 'D1', ts(1)), {
      activeUntil: String(Math.floor(T0 / 1000) + 10),
      channel: 'D1',
      id: 'w1',
      kind: 'thread',
      lastTs: ts(1),
      threadTs: ts(1),
      uniqueKey: threadKey('inst-1', 'D1', ts(1)),
    });
    env.clock.now = T0 + 60_000;
    await env.poller().tick();

    expect(env.store.states.has(threadKey('inst-1', 'D1', ts(1)))).toBe(false);
    expect(env.fake.replies).not.toHaveBeenCalled();
  });

  it('reports missing Slack scopes and still polls the conversation types it can list', async () => {
    const channels: FakeChannel[] = [{ id: 'C1', messages: [], type: 'public_channel' }];
    const env = setup(channels, { missingScopeTypes: ['im', 'mpim'] });

    const summary = await env.poller().tick();

    expect(summary.missingScopes).toEqual(['channels:read', 'im:read']);
    expect(summary.grantedScopes).toEqual(['channels:read', 'chat:write']);
    expect(summary.channels).toBe(1);
    expect(env.store.states.get(globalKey('inst-1'))?.status).toContain('im:read');
  });

  it('keeps the cursor on a per-channel history error and continues other channels', async () => {
    const channels: FakeChannel[] = [
      { id: 'C1', messages: [], type: 'public_channel' },
      { id: 'D1', messages: [], type: 'im' },
    ];
    const env = setup(channels);
    await env.poller().tick();
    channels[1]!.messages.push({ text: 'run', ts: ts(5), user: 'U1' });
    const realHistory = env.fake.history.getMockImplementation()!;
    env.fake.history.mockImplementation(async (args: { channel: string; oldest: string }) => {
      if (args.channel === 'C1') {
        throw Object.assign(new Error('missing_scope'), {
          data: { error: 'missing_scope', needed: 'channels:history' },
        });
      }
      return realHistory(args);
    });
    env.clock.now = T0 + 60_000;
    const summary = await env.poller().tick();

    expect(summary.errors.length).toBe(1);
    expect(summary.missingScopes).toEqual(['channels:history']);
    expect(env.store.states.get(channelKey('inst-1', 'C1'))?.lastTs).toBe(ts(0));
    expect(env.dispatched.map((m) => m.channel)).toEqual(['D1']);
  });
});

describe('workflow invoke mode and channel allowlist', () => {
  const channels = (): FakeChannel[] => [
    { id: 'C1', messages: [], type: 'public_channel' },
    { id: 'C2', messages: [], type: 'public_channel' },
  ];

  it('records a receipt with the event facts, and neither creates a DM nor invokes the agent', async () => {
    const chs = channels();
    const env = setup(chs);
    const buildReceiptPayload = jest.fn(async (m: QualifiedMessage) => ({
      sender: m.message.user!,
      text: m.message.text!,
      threadContext: 'ts=1 user=U9 text=earlier',
    }));
    env.deps.buildReceiptPayload = buildReceiptPayload;
    await env.poller().tick();
    chs[0]!.messages.push({ text: `${MENTION} do a thing`, ts: ts(5), user: 'U1' });
    env.clock.now = T0 + 60_000;
    const summary = await env.poller().tick();

    expect(summary.dispatched).toBe(1);
    expect(env.dispatch).not.toHaveBeenCalled();
    const key = receiptKey('inst-1', 'C1', ts(5));
    expect(env.store.payloads.get(key)).toMatchObject({ sender: 'U1', text: `${MENTION} do a thing` });
    expect(env.store.receipts.get(key)?.status).toBe('done');
    expect(env.store.receipts.get(key)?.dmObject).toBeUndefined();
  });

  it('calls onReceiptRecorded once per new receipt, and a failing hook does not block the receipt', async () => {
    const chs = channels();
    const env = setup(chs);
    env.deps.buildReceiptPayload = jest.fn(async () => ({ sender: 'U1', text: 'x' }));
    const onReceiptRecorded = jest.fn(async () => {
      throw new Error('reactions.add failed');
    });
    env.deps.onReceiptRecorded = onReceiptRecorded;
    await env.poller().tick();
    chs[0]!.messages.push({ text: `${MENTION} react to me`, ts: ts(5), user: 'U1' });
    env.clock.now = T0 + 60_000;
    const summary = await env.poller().tick();
    expect(summary.dispatched).toBe(1);
    expect(onReceiptRecorded).toHaveBeenCalledTimes(1);
    expect(onReceiptRecorded).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C1', ts: ts(5) }));
    expect(env.store.receipts.get(receiptKey('inst-1', 'C1', ts(5)))?.status).toBe('done');
    env.store.states.delete(channelKey('inst-1', 'C1'));
    env.store.states.set(channelKey('inst-1', 'C1'), {
      channel: 'C1',
      id: 'sx',
      kind: 'channel',
      lastTs: ts(0),
      uniqueKey: channelKey('inst-1', 'C1'),
    });
    env.clock.now = T0 + 120_000;
    await env.poller().tick();
    expect(onReceiptRecorded).toHaveBeenCalledTimes(1);
  });

  it('does not create a second receipt when the message is seen again', async () => {
    const chs = channels();
    const env = setup(chs);
    env.deps.buildReceiptPayload = jest.fn(async () => ({ sender: 'U1', text: 'x' }));
    await env.poller().tick();
    chs[0]!.messages.push({ text: `${MENTION} once`, ts: ts(5), user: 'U1' });
    env.clock.now = T0 + 60_000;
    await env.poller().tick();
    // Simulate a lost cursor: the same message is fetched again.
    env.store.states.delete(channelKey('inst-1', 'C1'));
    env.store.states.set(channelKey('inst-1', 'C1'), {
      channel: 'C1',
      id: 'sx',
      kind: 'channel',
      lastTs: ts(0),
      uniqueKey: channelKey('inst-1', 'C1'),
    });
    env.clock.now = T0 + 120_000;
    const summary = await env.poller().tick();
    expect(summary.dispatched).toBe(0);
    expect(summary.duplicatesSkipped).toBe(1);
    expect(env.store.receipts.size).toBe(1);
  });

  it('never records receipts for the bot own messages or other bots', async () => {
    const chs = channels();
    const env = setup(chs);
    env.deps.buildReceiptPayload = jest.fn(async () => ({ sender: 'x', text: 'x' }));
    await env.poller().tick();
    chs[0]!.messages.push({ bot_id: 'B9', text: `${MENTION} mine`, ts: ts(5), user: BOT });
    chs[0]!.messages.push({ bot_id: 'B8', text: `${MENTION} other bot`, ts: ts(6), user: 'UOTHERBOT' });
    chs[0]!.messages.push({ bot_id: 'B7', text: `${MENTION} human via user token`, ts: ts(7), user: 'U1' });
    env.clock.now = T0 + 60_000;
    await env.poller().tick();
    expect([...env.store.receipts.keys()]).toEqual([receiptKey('inst-1', 'C1', ts(7))]);
  });

  it('polls only allowlisted channels', async () => {
    const chs = channels();
    const env = setup(chs);
    env.deps.allowedChannels = parseChannelAllowlist(' C2 ,');
    await env.poller().tick();
    chs[0]!.messages.push({ text: `${MENTION} a`, ts: ts(5), user: 'U1' });
    chs[1]!.messages.push({ text: `${MENTION} b`, ts: ts(6), user: 'U1' });
    env.clock.now = T0 + 60_000;
    const summary = await env.poller().tick();
    expect(summary.channels).toBe(1);
    expect(env.dispatched.map((m) => m.channel)).toEqual(['C2']);
  });

  it('parses an empty allowlist as no restriction', () => {
    expect(parseChannelAllowlist(undefined)).toBeUndefined();
    expect(parseChannelAllowlist('  ')).toBeUndefined();
    expect([...parseChannelAllowlist('C1, C2')!]).toEqual(['C1', 'C2']);
  });
});
