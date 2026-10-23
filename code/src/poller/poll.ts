import type { WebClient } from '@slack/web-api';

import {
  channelKey,
  globalKey,
  type Receipt,
  type ReceiptPayload,
  type StateRecord,
  type StateStore,
  threadKey,
} from './state';

/** A claimed dispatch that has not completed within this window is treated as interrupted. */
export const RECEIPT_LEASE_MS = 10 * 60 * 1000;
/** Follow-ups in a thread the agent answered are polled for this long after the last invocation. */
export const THREAD_WATCH_SECONDS = 24 * 60 * 60;
/** Newly joined channels start this far before the previous tick to tolerate clock skew. */
export const NEW_CHANNEL_SKEW_SECONDS = 5;
/**
 * Threads whose root is at most this old are scanned for new replies that @mention the bot, so it can be pulled
 * into a thread another bot or person started. Older roots are only followed through an existing thread watch.
 */
export const THREAD_DISCOVERY_SECONDS = 24 * 60 * 60;
/** Stop starting new dispatches after this long so ticks do not overlap the next timer firing. */
export const TICK_BUDGET_MS = 45 * 1000;

const CONVERSATION_TYPES = ['im', 'public_channel', 'private_channel', 'mpim'] as const;

export const REQUIRED_SLACK_SCOPES = [
  'channels:history',
  'channels:read',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'mpim:history',
  'mpim:read',
] as const;

export interface SlackHistoryMessage {
  bot_id?: string;
  edited?: unknown;
  files?: unknown[];
  latest_reply?: string;
  reply_count?: number;
  subtype?: string;
  text?: string;
  thread_ts?: string;
  ts?: string;
  user?: string;
}

export interface Conversation {
  id: string;
  isIm: boolean;
}

export interface QualifiedMessage {
  channel: string;
  isIm: boolean;
  message: SlackHistoryMessage;
  threadTs: string;
  ts: string;
}

export type DispatchFn = (
  message: QualifiedMessage,
  onDmResolved: (dmObject: string) => Promise<void>
) => Promise<void>;

/** Returns true when the agent-executing comment for this message already exists in the DM. */
export type DispatchedCheck = (dmObject: string, channel: string, messageTs: string) => Promise<boolean>;

export type SlackPollClient = Pick<WebClient, 'conversations' | 'users'>;

/** Collects the Slack event facts stored on the receipt in workflow invoke mode. */
export type ReceiptPayloadFn = (message: QualifiedMessage) => Promise<ReceiptPayload>;

/** Parses the comma-separated channel_allowlist input; empty means every channel the bot belongs to. */
export const parseChannelAllowlist = (value: string | undefined): Set<string> | undefined => {
  const ids = (value ?? '')
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length > 0 ? new Set(ids) : undefined;
};

export interface PollDeps {
  /** When set, only these conversations are polled. */
  allowedChannels?: Set<string>;
  /**
   * Workflow invoke mode: the receipt is created with the Slack event facts and no DM is created or agent invoked.
   * The receipt-created workflow trigger is the only consumer.
   */
  buildReceiptPayload?: ReceiptPayloadFn;
  /** Workflow invoke mode: runs once after a new receipt is recorded. Best effort; a failure never blocks the receipt. */
  onReceiptRecorded?: (message: QualifiedMessage) => Promise<void>;
  botUserId: string;
  dispatch: DispatchFn;
  installId: string;
  isDispatched: DispatchedCheck;
  log?: (message: string) => void;
  now?: () => number;
  slack: SlackPollClient;
  store: StateStore;
}

export interface TickSummary {
  channels: number;
  dispatched: number;
  duplicatesSkipped: number;
  errors: string[];
  firstRun: boolean;
  /** Scopes granted to the bot token, as reported by Slack's x-oauth-scopes response header. */
  grantedScopes: string[];
  inFlight: number;
  missingScopes: string[];
  threads: number;
}

export const toSlackTs = (ms: number): string => (ms / 1000).toFixed(6);

/** Slack timestamps are fixed-width decimal strings; compare numerically to be safe. */
export const tsGreater = (a: string, b: string): boolean => Number(a) > Number(b);

export const maxTs = (a: string | undefined, b: string | undefined): string | undefined => {
  if (!a) return b;
  if (!b) return a;
  return tsGreater(a, b) ? a : b;
};

const slackErrorCode = (error: unknown): string =>
  (error as { data?: { error?: string } })?.data?.error ?? (error instanceof Error ? error.message : String(error));

const slackErrorNeeded = (error: unknown): string | undefined =>
  (error as { data?: { needed?: string } })?.data?.needed;

/**
 * Decides whether a Slack message should invoke the agent. DMs accept any message with text; channels,
 * private channels, and group DMs require an explicit @mention of the bot. System messages are skipped.
 * A `bot_id` alone does not disqualify: a person posting through an app's user token carries one, so the
 * poller resolves whether the author is a bot separately.
 */
export const qualifies = (message: SlackHistoryMessage, isIm: boolean, botUserId: string): boolean => {
  if (!message.ts || !message.user || message.user === botUserId) return false;
  if (message.subtype && message.subtype !== 'file_share' && message.subtype !== 'thread_broadcast') return false;
  const text = message.text?.trim() ?? '';
  if (isIm) return text.length > 0;
  const mention = `<@${botUserId}>`;
  return text.includes(mention) && text.replaceAll(mention, '').trim().length > 0;
};

/** Converts a polled message into the Slack Events API payload shape the existing invoke logic parses. */
export const toEventPayload = (message: QualifiedMessage): Record<string, unknown> => {
  // The author is already confirmed human; the parsers reject any bot_id.
  const { bot_id: _botId, edited: _edited, subtype, ...rest } = message.message;
  return {
    event: {
      ...rest,
      channel: message.channel,
      ...(message.isIm ? { channel_type: 'im', type: 'message' } : { type: 'app_mention' }),
      // The DM parser accepts file shares; the mention parser rejects any subtype.
      ...(message.isIm && subtype === 'file_share' ? { subtype } : {}),
      ...(message.message.thread_ts ? { thread_ts: message.message.thread_ts } : {}),
    },
    type: 'event_callback',
  };
};

const byTsAscending = (a: SlackHistoryMessage, b: SlackHistoryMessage): number => Number(a.ts) - Number(b.ts);

export class SlackPoller {
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private tickStartMs = 0;
  private readonly isBotUser = new Map<string, boolean>();

  constructor(private readonly deps: PollDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((message) => console.info(message));
  }

  private budgetExhausted(): boolean {
    return this.now() - this.tickStartMs > TICK_BUDGET_MS;
  }

  /** A users.info failure throws so the channel cursor stays before this message and it is retried next tick. */
  private async isHumanAuthor(message: SlackHistoryMessage): Promise<boolean> {
    if (!message.bot_id) return true;
    const userId = message.user!;
    let isBot = this.isBotUser.get(userId);
    if (isBot === undefined) {
      const response = await this.deps.slack.users.info({ user: userId });
      isBot = !!response.user?.is_bot || response.user?.id === 'USLACKBOT';
      this.isBotUser.set(userId, isBot);
    }
    return !isBot;
  }

  async listConversations(summary: TickSummary): Promise<Conversation[]> {
    const conversations = new Map<string, Conversation>();
    for (const type of CONVERSATION_TYPES) {
      let cursor: string | undefined;
      try {
        do {
          const response = await this.deps.slack.users.conversations({
            exclude_archived: true,
            limit: 200,
            types: type,
            ...(cursor ? { cursor } : {}),
          });
          const granted = (response.response_metadata as { scopes?: string[] } | undefined)?.scopes;
          if (granted?.length) summary.grantedScopes = granted;
          for (const channel of response.channels ?? []) {
            if (channel.id) conversations.set(channel.id, { id: channel.id, isIm: type === 'im' || !!channel.is_im });
          }
          cursor = response.response_metadata?.next_cursor || undefined;
        } while (cursor);
      } catch (error) {
        const code = slackErrorCode(error);
        const needed = slackErrorNeeded(error);
        if (code === 'missing_scope' && needed) summary.missingScopes.push(...needed.split(','));
        summary.errors.push(`users.conversations(${type}): ${code}${needed ? ` needs ${needed}` : ''}`);
      }
    }
    const { allowedChannels } = this.deps;
    return [...conversations.values()].filter((c) => !allowedChannels || allowedChannels.has(c.id));
  }

  private async fetchHistory(channel: string, oldest: string): Promise<SlackHistoryMessage[]> {
    const messages: SlackHistoryMessage[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.deps.slack.conversations.history({
        channel,
        inclusive: false,
        limit: 200,
        oldest,
        ...(cursor ? { cursor } : {}),
      });
      messages.push(...((response.messages ?? []) as SlackHistoryMessage[]));
      cursor = response.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return messages.filter((m) => m.ts && tsGreater(m.ts, oldest)).sort(byTsAscending);
  }

  private async fetchReplies(channel: string, threadTs: string, oldest: string): Promise<SlackHistoryMessage[]> {
    const messages: SlackHistoryMessage[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.deps.slack.conversations.replies({
        channel,
        inclusive: false,
        limit: 200,
        oldest,
        ts: threadTs,
        ...(cursor ? { cursor } : {}),
      });
      messages.push(...((response.messages ?? []) as SlackHistoryMessage[]));
      cursor = response.response_metadata?.next_cursor || undefined;
    } while (cursor);
    // The thread root is always returned; history owns it, so only replies newer than the cursor count here.
    return messages.filter((m) => m.ts && m.ts !== threadTs && tsGreater(m.ts, oldest)).sort(byTsAscending);
  }

  /**
   * Dispatches one message exactly once using a write-ahead receipt keyed by channel and message ts.
   * Returns false when the message must be retried on a later tick (another tick holds the claim).
   */
  private async processMessage(qualified: QualifiedMessage, summary: TickSummary): Promise<boolean> {
    const { store } = this.deps;
    if (this.deps.buildReceiptPayload) return this.recordWorkflowReceipt(qualified, summary);
    const claim = await store.claimReceipt(qualified.channel, qualified.ts, qualified.threadTs, this.now());
    let receipt: Receipt;
    if (claim.claimed) {
      receipt = claim.receipt;
    } else {
      const existing = claim.existing;
      if (existing.status === 'done') {
        summary.duplicatesSkipped += 1;
        return true;
      }
      if (this.now() - existing.claimedAt < RECEIPT_LEASE_MS) {
        summary.inFlight += 1;
        return false;
      }
      // Interrupted dispatch: the DM is recorded before the executing comment is posted, so its
      // absence proves the comment was never posted. When present, the comment's external_ref decides.
      if (existing.dmObject && (await this.deps.isDispatched(existing.dmObject, qualified.channel, qualified.ts))) {
        await store.completeReceipt(existing);
        summary.duplicatesSkipped += 1;
        return true;
      }
      receipt = await store.reclaimReceipt(existing, this.now());
    }

    await this.deps.dispatch(qualified, (dmObject) => store.recordReceiptDm(receipt, dmObject));
    await store.completeReceipt(receipt);
    summary.dispatched += 1;
    this.log(`dispatched slack message ${qualified.channel}/${qualified.ts}`);
    await this.watchThread(qualified.channel, qualified.threadTs, qualified.ts);
    return true;
  }

  /**
   * Workflow invoke mode: one receipt per channel and message ts, created with all event facts in a single call so the
   * receipt-created trigger fires with complete data. An existing receipt means the message was already recorded.
   */
  private async recordWorkflowReceipt(qualified: QualifiedMessage, summary: TickSummary): Promise<boolean> {
    const { store } = this.deps;
    const payload = await this.deps.buildReceiptPayload!(qualified);
    const claim = await store.claimReceipt(qualified.channel, qualified.ts, qualified.threadTs, this.now(), payload);
    if (!claim.claimed) {
      summary.duplicatesSkipped += 1;
      return true;
    }
    await store.completeReceipt(claim.receipt);
    summary.dispatched += 1;
    await this.deps.onReceiptRecorded?.(qualified).catch(() => undefined);
    this.log(`recorded slack message ${qualified.channel}/${qualified.ts} for workflow`);
    await this.watchThread(qualified.channel, qualified.threadTs, qualified.ts);
    return true;
  }

  private async watchThread(channel: string, threadTs: string, fromTs: string): Promise<void> {
    const key = threadKey(this.deps.installId, channel, threadTs);
    const existing = await this.deps.store.getState(key);
    await this.deps.store.saveState({
      activeUntil: String(Math.floor(this.now() / 1000) + THREAD_WATCH_SECONDS),
      channel,
      id: existing?.id,
      kind: 'thread',
      lastTs: maxTs(existing?.lastTs, fromTs),
      threadTs,
      uniqueKey: key,
    });
  }

  /** Processes messages in ts order and returns the cursor to persist: the last message fully handled. */
  private async processOrdered(
    messages: SlackHistoryMessage[],
    channel: string,
    isIm: boolean,
    cursor: string,
    summary: TickSummary
  ): Promise<string> {
    let advanced = cursor;
    for (const message of messages) {
      const ts = message.ts!;
      if (qualifies(message, isIm, this.deps.botUserId) && (await this.isHumanAuthor(message))) {
        if (this.budgetExhausted()) break;
        const threadTs = message.thread_ts ?? ts;
        const handled = await this.processMessage({ channel, isIm, message, threadTs, ts }, summary);
        if (!handled) break;
      } else if (isIm && message.user === this.deps.botUserId && (!message.thread_ts || message.thread_ts === ts)) {
        // A proactive bot DM has no inbound dispatch to start a watch. Follow its human replies without invoking the bot.
        if (this.budgetExhausted()) break;
        await this.watchThread(channel, ts, ts);
      }
      advanced = ts;
    }
    return advanced;
  }

  /**
   * Starts a thread watch for each unwatched thread with a reply since `sinceTs` that @mentions the bot, then polls
   * it. The watch starts at `sinceTs`, so an interrupted dispatch resumes from the watch on the next tick.
   */
  private async discoverThreads(
    roots: SlackHistoryMessage[],
    channel: string,
    sinceTs: string,
    watchedThreads: Set<string>,
    summary: TickSummary
  ): Promise<void> {
    for (const root of roots) {
      if (!root.ts || !root.reply_count || !root.latest_reply || !tsGreater(root.latest_reply, sinceTs)) continue;
      if (watchedThreads.has(`${channel}:${root.ts}`) || this.budgetExhausted()) continue;
      const replies = await this.fetchReplies(channel, root.ts, sinceTs);
      let mentioned = false;
      for (const reply of replies) {
        if (qualifies(reply, false, this.deps.botUserId) && (await this.isHumanAuthor(reply))) {
          mentioned = true;
          break;
        }
      }
      if (!mentioned) continue;
      const key = threadKey(this.deps.installId, channel, root.ts);
      watchedThreads.add(`${channel}:${root.ts}`);
      // A root dispatched earlier in this tick already has a watch; its replies are polled next tick.
      if (await this.deps.store.getState(key)) continue;
      const watch = await this.deps.store.saveState({
        activeUntil: String(Math.floor(this.now() / 1000) + THREAD_WATCH_SECONDS),
        channel,
        kind: 'thread',
        lastTs: sinceTs,
        threadTs: root.ts,
        uniqueKey: key,
      });
      summary.threads += 1;
      await this.pollThread(watch, false, summary);
    }
  }

  private async pollChannel(
    conversation: Conversation,
    existing: StateRecord | undefined,
    initialCursor: string,
    summary: TickSummary,
    discovery?: { sinceTs: string; watchedThreads: Set<string> }
  ): Promise<void> {
    const { store } = this.deps;
    const cursor = existing?.lastTs ?? initialCursor;
    // DMs need no discovery: every DM thread the bot answered is already watched.
    const discover = discovery && !conversation.isIm ? discovery : undefined;
    const lookbackTs = toSlackTs(this.now() - THREAD_DISCOVERY_SECONDS * 1000);
    const oldest = discover && tsGreater(cursor, lookbackTs) ? lookbackTs : cursor;
    const fetched = await this.fetchHistory(conversation.id, oldest);
    const messages = fetched.filter((m) => tsGreater(m.ts!, cursor));
    let advanced = cursor;
    try {
      advanced = await this.processOrdered(messages, conversation.id, conversation.isIm, cursor, summary);
      if (discover) {
        await this.discoverThreads(fetched, conversation.id, discover.sinceTs, discover.watchedThreads, summary);
      }
    } finally {
      if (!existing || advanced !== existing.lastTs) {
        await store.saveState({
          channel: conversation.id,
          id: existing?.id,
          kind: 'channel',
          lastTs: advanced,
          uniqueKey: channelKey(this.deps.installId, conversation.id),
        });
      }
    }
  }

  private async pollThread(watch: StateRecord, isIm: boolean, summary: TickSummary): Promise<void> {
    const { store } = this.deps;
    if (!watch.channel || !watch.threadTs || !watch.lastTs) return;
    if (this.deps.allowedChannels && !this.deps.allowedChannels.has(watch.channel)) return;
    if (Number(watch.activeUntil ?? 0) * 1000 < this.now()) {
      await store.deleteState(watch);
      return;
    }
    const replies = await this.fetchReplies(watch.channel, watch.threadTs, watch.lastTs);
    let advanced = watch.lastTs;
    try {
      advanced = await this.processOrdered(replies, watch.channel, isIm, watch.lastTs, summary);
    } finally {
      if (advanced !== watch.lastTs) {
        // Re-read: dispatching in this thread extends the watch window, which must not be overwritten.
        const latest = await store.getState(watch.uniqueKey);
        await store.saveState({ ...(latest ?? watch), lastTs: maxTs(latest?.lastTs, advanced) });
      }
    }
  }

  async tick(): Promise<TickSummary> {
    const { store } = this.deps;
    this.tickStartMs = this.now();
    const tickTs = toSlackTs(this.tickStartMs);
    const summary: TickSummary = {
      channels: 0,
      dispatched: 0,
      duplicatesSkipped: 0,
      errors: [],
      firstRun: false,
      grantedScopes: [],
      inFlight: 0,
      missingScopes: [],
      threads: 0,
    };

    const states = await store.listState();
    let global = states.find((s) => s.uniqueKey === globalKey(this.deps.installId));
    if (!global) {
      // First run: start from now instead of backfilling history.
      summary.firstRun = true;
      global = await store.saveState({ kind: 'global', lastTs: tickTs, uniqueKey: globalKey(this.deps.installId) });
    }
    const channelStates = new Map(states.filter((s) => s.kind === 'channel').map((s) => [s.channel, s]));
    const newChannelCursor = summary.firstRun
      ? tickTs
      : String((Number(global.lastTickTs ?? global.lastTs ?? tickTs) - NEW_CHANNEL_SKEW_SECONDS).toFixed(6));

    // Replies since the previous tick are new; the first run has no previous tick and does not backfill.
    const discovery = summary.firstRun
      ? undefined
      : {
          sinceTs: newChannelCursor,
          watchedThreads: new Set(
            states
              .filter((s) => s.kind === 'thread' && s.channel && s.threadTs)
              .map((s) => `${s.channel}:${s.threadTs}`)
          ),
        };

    const conversations = await this.listConversations(summary);
    const imChannels = new Set(conversations.filter((c) => c.isIm).map((c) => c.id));
    for (const conversation of conversations) {
      summary.channels += 1;
      try {
        await this.pollChannel(conversation, channelStates.get(conversation.id), newChannelCursor, summary, discovery);
      } catch (error) {
        const code = slackErrorCode(error);
        const needed = slackErrorNeeded(error);
        if (code === 'missing_scope' && needed) summary.missingScopes.push(...needed.split(','));
        summary.errors.push(`channel ${conversation.id}: ${code}${needed ? ` needs ${needed}` : ''}`);
      }
    }

    for (const watch of states.filter((s) => s.kind === 'thread')) {
      summary.threads += 1;
      try {
        const isIm = !!watch.channel && (imChannels.has(watch.channel) || watch.channel.startsWith('D'));
        await this.pollThread(watch, isIm, summary);
      } catch (error) {
        summary.errors.push(`thread ${watch.channel}/${watch.threadTs}: ${slackErrorCode(error)}`);
      }
    }

    summary.missingScopes = [...new Set(summary.missingScopes)].sort();
    await store.saveState({
      ...global,
      lastTickTs: tickTs,
      status: JSON.stringify({
        channels: summary.channels,
        dispatched: summary.dispatched,
        duplicates_skipped: summary.duplicatesSkipped,
        errors: summary.errors.slice(0, 10),
        granted_scopes: summary.grantedScopes,
        in_flight: summary.inFlight,
        missing_scopes: summary.missingScopes,
        threads: summary.threads,
      }),
    });
    return summary;
  }
}
