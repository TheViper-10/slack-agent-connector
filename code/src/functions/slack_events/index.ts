import { createHmac, timingSafeEqual } from 'node:crypto';

import type { HandleMessageResult, QualifiedMessage, SlackHistoryMessage } from '../../poller/poll';
import { type FunctionEvent, getKeyring } from '../../types';
import { createPoller } from '../slack_poller';

/** Slack rejects replays older than this; so do we. */
export const MAX_EVENT_AGE_SECONDS = 5 * 60;

/** The event_type DevRev assigns to the `slack_events` event key emitted by the `slack-events` source. */
export const SLACK_EVENTS_EVENT_TYPE = 'custom:slack_events';

interface SlackEventsPayload {
  body_raw?: string;
  headers?: Record<string, string | undefined>;
}

interface SlackEnvelope {
  api_app_id?: string;
  event?: SlackHistoryMessage & { channel?: string; channel_type?: string; type?: string };
  type?: string;
}

/** Verifies Slack's v0 signature (HMAC-SHA256 over `v0:<ts>:<raw body>`) and rejects stale timestamps. */
export const verifySlackSignature = (
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  bodyRaw: string | undefined,
  nowMs: number = Date.now()
): boolean => {
  if (!secret || !timestamp || !signature || bodyRaw === undefined) return false;
  const ageSeconds = Math.abs(nowMs / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > MAX_EVENT_AGE_SECONDS) return false;
  const expected = Buffer.from(`v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${bodyRaw}`).digest('hex')}`);
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

/** Maps an accepted Slack event to the message shape the poller produces; undefined for events we do not handle. */
export const toQualifiedMessage = (envelope: SlackEnvelope): QualifiedMessage | undefined => {
  const event = envelope.event;
  if (envelope.type !== 'event_callback' || !event?.channel || !event.ts) return undefined;
  const isMention = event.type === 'app_mention';
  const isDirect = event.type === 'message' && (event.channel_type === 'im' || event.channel_type === 'mpim');
  if (!isMention && !isDirect) return undefined;
  const { bot_id, files, subtype, text, thread_ts, ts, user } = event;
  return {
    channel: event.channel,
    // Group DMs behave like channels: they need an explicit @mention, exactly as in the poller.
    isIm: isDirect && event.channel_type === 'im',
    message: { bot_id, files, subtype, text, thread_ts, ts, user },
    threadTs: thread_ts ?? ts!,
    ts: event.ts,
  };
};

export type SlackEventOutcome = HandleMessageResult | 'dropped';

/**
 * Events API ingress. The webhook has already acknowledged Slack, so every refusal is logged and dropped; the
 * poller remains the safety net for anything dropped or failed here.
 */
export const handleSlackEvent = async (
  event: FunctionEvent,
  buildPoller: typeof createPoller = createPoller
): Promise<SlackEventOutcome> => {
  const drop = (reason: string): SlackEventOutcome => {
    console.warn(`slack event dropped: ${reason}`);
    return 'dropped';
  };
  const secret = getKeyring(event, 'slack_signing_secret')?.secret;
  if (!secret) return drop('slack_signing_secret is not configured');
  const payload = event.payload as SlackEventsPayload;
  const headers = payload.headers ?? {};
  if (
    !verifySlackSignature(secret, headers['X-Slack-Request-Timestamp'], headers['X-Slack-Signature'], payload.body_raw)
  ) {
    return drop('signature check failed');
  }

  let envelope: SlackEnvelope;
  try {
    envelope = JSON.parse(payload.body_raw!) as SlackEnvelope;
  } catch {
    return drop('body is not JSON');
  }
  // One Slack app per install: ignore deliveries addressed to a different app.
  const appId = event.input_data.global_values?.['slack_app_id'];
  if (appId && envelope.api_app_id && envelope.api_app_id !== appId) return drop('event is for another Slack app');
  const qualified = toQualifiedMessage(envelope);
  if (!qualified) return drop(`unsupported event ${envelope.type}/${envelope.event?.type}`);

  const result = await (await buildPoller(event)).handleMessage(qualified);
  console.info(
    `slack event ${qualified.channel}/${qualified.ts}: ${result} retry_num=${headers['X-Slack-Retry-Num'] || '0'}`
  );
  return result;
};
