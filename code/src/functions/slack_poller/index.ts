import { WebClient } from '@slack/web-api';
import axios from 'axios';

import { formatDevRevError, redactSecrets } from '../../agent/errors';
import { invokeAgentFromSlack } from '../../agent/invoke';
import { DevRevClient } from '../../clients/devrev';
import {
  parseChannelAllowlist,
  type QualifiedMessage,
  SlackPoller,
  type TickSummary,
  toEventPayload,
} from '../../poller/poll';
import { claimSlackApp } from '../../poller/claim';
import { DevRevStateStore, type ReceiptPayload, resolveStateViewer } from '../../poller/state';
import { type FunctionEvent, getKeyring } from '../../types';

export const executingCommentRef = (channel: string, messageTs: string): string => `slack:${channel}:${messageTs}`;

/** Checks whether the agent-executing comment for a Slack message already exists in the DM. */
export const isDispatchedIn =
  (devrev: DevRevClient) =>
  async (dmObject: string, channel: string, messageTs: string): Promise<boolean> => {
    try {
      const response = await devrev.post<{ timeline_entry?: { id?: string } }>('timeline-entries.get', {
        external_ref: executingCommentRef(channel, messageTs),
        id: dmObject,
      });
      return !!response.timeline_entry?.id;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) return false;
      throw error;
    }
  };

export const THREAD_CONTEXT_MESSAGES = 10;

/** Workflow invoke mode: the Slack facts stored on the receipt (sender, text, bounded earlier thread messages). */
export const buildReceiptPayloadFor =
  (slack: WebClient) =>
  async (qualified: QualifiedMessage): Promise<ReceiptPayload> => {
    const names = new Map<string, string>();
    const nameOf = async (userId: string | undefined): Promise<string> => {
      if (!userId) return '';
      if (names.has(userId)) return names.get(userId)!;
      let name = '';
      try {
        const response = await slack.users.info({ user: userId });
        name = response.user?.profile?.display_name || response.user?.profile?.real_name || response.user?.name || '';
      } catch {
        // Display name is best effort.
      }
      names.set(userId, name);
      return name;
    };

    let threadContext = '';
    if (qualified.message.thread_ts && qualified.message.thread_ts !== qualified.ts) {
      try {
        const response = await slack.conversations.replies({
          channel: qualified.channel,
          latest: qualified.ts,
          inclusive: false,
          limit: 200,
          ts: qualified.message.thread_ts,
        });
        const earlier = (
          (response.messages ?? []) as Array<{ text?: string; ts?: string; user?: string; bot_id?: string }>
        )
          .filter((m) => m.ts && Number(m.ts) < Number(qualified.ts))
          .slice(-THREAD_CONTEXT_MESSAGES);
        const lines: string[] = [];
        for (const m of earlier) {
          const who = m.user ?? m.bot_id ?? 'unknown';
          const name = await nameOf(m.user);
          lines.push(`ts=${m.ts} user=${who}${name ? ` (${name})` : ''} text=${(m.text ?? '').replace(/\n/g, ' ')}`);
        }
        threadContext = lines.join('\n');
      } catch (error) {
        console.warn('thread context fetch failed:', error instanceof Error ? error.message : String(error));
      }
    }

    return {
      parentTs: qualified.message.thread_ts ?? '',
      sender: qualified.message.user ?? '',
      senderName: await nameOf(qualified.message.user),
      text: qualified.message.text ?? '',
      threadContext,
    };
  };

/** Builds the poller (deps, receipt payload, dispatch) for one install; shared by the timer tick and Events API ingress. */
export const createPoller = async (event: FunctionEvent): Promise<SlackPoller> => {
  const slackToken = getKeyring(event, 'slack_connection')?.secret;
  if (!slackToken) throw new Error('Slack connection is required');
  const botUserId = event.input_data.global_values?.['slack_bot_user_id'];
  if (!botUserId) throw new Error('slack_bot_user_id is not set; re-run activation');

  const devrev = new DevRevClient(
    event.execution_metadata.devrev_endpoint,
    event.context.secrets.service_account_token
  );
  // Fail fast on rate limits so one throttled channel does not stall the tick; its cursor stays put.
  const slack = new WebClient(slackToken, { rejectRateLimitedCalls: true, retryConfig: { retries: 1 } });

  // Refuse to poll a Slack app another install owns (also covers a claim deferred at first activation).
  const appId = event.input_data.global_values?.['slack_app_id'];
  if (appId) await claimSlackApp(devrev, appId, event.context.snap_in_id);

  // Share poll state read-only with the configured act-as user so operators can inspect cursors and receipts.
  const viewer = await resolveStateViewer(devrev, event.input_data.global_values?.['act_as_user_id']);
  const workflowMode = event.input_data.global_values?.['invoke_mode']?.trim().toLowerCase() === 'workflow';
  const poller = new SlackPoller({
    allowedChannels: parseChannelAllowlist(event.input_data.global_values?.['channel_allowlist']),
    botUserId,
    ...(workflowMode
      ? {
          // Workflow mode adds no reaction: every mark in Slack is the agent's own reply or reaction.
          buildReceiptPayload: buildReceiptPayloadFor(slack),
        }
      : {}),
    dispatch: (message, onDmResolved) =>
      invokeAgentFromSlack({ ...event, payload: toEventPayload(message) }, devrev, slack, { onDmResolved }),
    installId: event.context.snap_in_id,
    isDispatched: isDispatchedIn(devrev),
    slack,
    store: new DevRevStateStore(devrev, event.context.snap_in_id, viewer),
  });
  return poller;
};

export const handleEvent = async (event: FunctionEvent): Promise<TickSummary | undefined> => {
  const poller = await createPoller(event);
  const summary = await poller.tick();
  console.info(
    `slack poll tick: first_run=${summary.firstRun} channels=${summary.channels} threads=${summary.threads} ` +
      `dispatched=${summary.dispatched} duplicates_skipped=${summary.duplicatesSkipped} in_flight=${summary.inFlight} ` +
      `missing_scopes=${summary.missingScopes.join(',') || 'none'} errors=${summary.errors.length}`
  );
  for (const error of summary.errors) console.warn(`slack poll error: ${error}`);
  return summary;
};

const run = async (events: FunctionEvent[]): Promise<void> => {
  for (const event of events) {
    try {
      await handleEvent(event);
    } catch (error) {
      // Name the failing DevRev call (method, path, status, API message) before the runtime logs the bare error.
      const secrets = [event.context.secrets?.service_account_token, getKeyring(event, 'slack_connection')?.secret];
      console.error(`slack poll failed: ${redactSecrets(formatDevRevError(error), secrets)}`);
      throw error;
    }
  }
};

export default run;
