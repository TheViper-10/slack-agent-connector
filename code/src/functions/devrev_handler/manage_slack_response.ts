import { createHash, randomUUID } from 'node:crypto';
import axios from 'axios';
import type { WebClient } from '@slack/web-api';
import { APP_NAME } from '../../agent/constants';
import type { DevRevClient } from '../../clients/devrev';
import { keyPrefix, resolveStateViewer, STATE_LEAF_TYPE, type StateViewer } from '../../poller/state';

// Existing private state rows only. Every stage is immutable; the send-intent row is never updated,
// reclaimed or deleted. A request timeout is unresolved, not authorization to send again.
export const RESPONSE_KIND = 'response';
export type SlackResponseAction = 'prepare' | 'record_triage' | 'send' | 'reconcile' | 'get' | 'finalize' | 'fail';
export interface ManageSlackResponseInput {
  install: string;
  channel?: string;
  message_ts?: string;
  thread_ts?: string;
  receipt_id?: string;
  response_event?: string;
  session_key?: string;
  agent_session_id?: string;
  agent_id?: string;
  skill_call_id?: string;
  workflow_run_id?: string;
  rationale?: string;
  decision?: string;
  job_id?: string;
  acting_session?: string;
  text?: string;
  error_code?: string;
  workflow_mode?: string;
}
export interface ManageSlackResponseOutput {
  outcome: 'ok' | 'blocked' | 'unknown' | 'error';
  posted: boolean;
  record_id?: string;
  slack_ts?: string;
  summary: string;
}
export interface SlackSendDeps {
  slack: WebClient;
}
interface Row {
  id?: string;
  leaf_type?: string;
  unique_key?: string;
  custom_fields?: Record<string, unknown>;
}
interface Evidence extends Record<string, unknown> {
  channel?: string;
  slack_ts?: string;
  thread_ts?: string;
  response_key?: string;
  attempt_id?: string;
  writer_nonce?: string;
  decision?: string;
  rationale?: string;
}
interface Saved {
  id: string;
  data: Evidence;
}
const field = (name: string): string => `app_${APP_NAME}__${name}`;
const spec = { apps: [APP_NAME], tenant_fragment: true };
const hash = (s: string): string => createHash('sha256').update(s).digest('hex');
const status = (e: unknown, n: number): boolean => axios.isAxiosError(e) && e.response?.status === n;
const output = (
  outcome: ManageSlackResponseOutput['outcome'],
  summary: string,
  row?: Saved
): ManageSlackResponseOutput => ({
  outcome,
  summary,
  posted: outcome === 'ok' && typeof row?.data.slack_ts === 'string',
  record_id: row?.id,
  slack_ts: typeof row?.data.slack_ts === 'string' ? row.data.slack_ts : undefined,
});
export const responseKey = (install: string, channel: string, ts: string, event: string): string =>
  `${keyPrefix(install)}response:${channel}:${ts}:${event}`;
export const lockKey = (install: string, channel: string, ts: string, event: string): string =>
  `${responseKey(install, channel, ts, event)}:intent`;
export const factKey = (install: string, channel: string, ts: string, event: string, stage: string): string =>
  `${responseKey(install, channel, ts, event)}:${stage}`;

class Store {
  constructor(
    private readonly api: DevRevClient,
    private readonly viewer: StateViewer
  ) {}
  async raw(key: string): Promise<Row | undefined> {
    try {
      return (await this.api.post<{ custom_object?: Row }>('custom-objects.get', { unique_key: key })).custom_object;
    } catch (e) {
      if (status(e, 404)) return undefined;
      throw e;
    }
  }
  async read(key: string): Promise<Saved | undefined> {
    const row = await this.raw(key);
    if (!row?.id) return undefined;
    if (row.leaf_type !== STATE_LEAF_TYPE) throw new Error('unexpected_record_type');
    const body = row.custom_fields?.[field('status')];
    if (typeof body !== 'string') throw new Error('unreadable_record');
    return { id: row.id, data: JSON.parse(body) as Evidence };
  }
  // Distinct nonce on every competing intent creation prevents identical-body server dedup from
  // masquerading as ownership. Even HTTP201 requires a persisted nonce readback before a send.
  async create(key: string, data: Evidence): Promise<{ row?: Saved; won: boolean }> {
    const body = JSON.stringify(data);
    if (Buffer.byteLength(body, 'utf8') > 120000) throw new Error('record_too_large');
    let created = false;
    try {
      await this.api.post('custom-objects.create', {
        leaf_type: STATE_LEAF_TYPE,
        title: key,
        unique_key: key,
        custom_schema_spec: spec,
        custom_fields: {
          [field('kind')]: RESPONSE_KIND,
          [field('channel')]: data.channel ?? '',
          [field('thread_ts')]: data.thread_ts ?? '',
          [field('status')]: body,
        },
        shared_with: [{ member: this.viewer.member, role: this.viewer.stateRole }],
      });
      created = true;
    } catch (e) {
      if (!status(e, 409)) {
        // Unknown create result: read for evidence, but NEVER grant permission to send.
        let row: Saved | undefined;
        try {
          row = await this.read(key);
        } catch {
          /* Keep unresolved. */
        }
        return { row, won: false };
      }
    }
    const row = await this.read(key);
    return { row, won: created && !!row && row.data.writer_nonce === data.writer_nonce };
  }
  async fact(key: string, data: Evidence): Promise<Saved> {
    const existing = await this.read(key);
    if (existing) return existing;
    const result = await this.create(key, { ...data, writer_nonce: randomUUID() });
    if (!result.row) throw new Error('evidence_write_unconfirmed');
    return result.row;
  }
}

const base = (i: ManageSlackResponseInput): Evidence => ({
  install: i.install,
  channel: i.channel,
  message_ts: i.message_ts,
  thread_ts: i.thread_ts || i.message_ts,
  receipt_id: i.receipt_id ?? 'unknown',
  response_event: i.response_event,
  timestamp: new Date().toISOString(),
  workflow_run_id: i.workflow_run_id ?? 'unknown',
  session_key: i.session_key ?? 'unknown',
  agent_session_id: i.agent_session_id ?? 'unknown',
  skill_call_id: i.skill_call_id ?? 'unknown',
});
const keyFor = (i: ManageSlackResponseInput, stage: string): string =>
  factKey(i.install, i.channel as string, i.message_ts as string, i.response_event as string, stage);
const sessionFacts = async (api: DevRevClient, i: ManageSlackResponseInput): Promise<Evidence> => {
  try {
    let id = i.agent_session_id;
    if (!id && i.session_key && i.agent_id) {
      const listed = await api.post<{ agent_sessions?: Array<{ id?: string; session_object?: string }> }>(
        'ai-agent.sessions.list',
        { agent: [i.agent_id], session_object: [i.session_key], limit: 10 }
      );
      const matches = (listed.agent_sessions ?? []).filter((s) => s.session_object === i.session_key);
      if (matches.length === 1) id = matches[0].id;
    }
    if (!id)
      return {
        agent_session_id: 'unknown',
        session_creator: 'unknown',
        session_runtime: 'unknown',
        session_version: 'unknown',
      };
    const r = await api.post<{
      agent_session?: {
        agent?: string;
        created_by?: { id?: string };
        options?: { runtime?: string };
        agent_version?: string | { id?: string };
      };
    }>('ai-agent.sessions.get', { id });
    const s = r.agent_session;
    return {
      agent_session_id: id,
      agent_id: s?.agent ?? 'unknown',
      session_creator: s?.created_by?.id ?? 'unknown',
      session_runtime: s?.options?.runtime ?? 'unknown',
      session_version: typeof s?.agent_version === 'string' ? s.agent_version : (s?.agent_version?.id ?? 'unknown'),
    };
  } catch {
    return {
      agent_session_id: i.agent_session_id ?? 'unknown',
      session_creator: 'unknown',
      session_runtime: 'unknown',
      session_version: 'unknown',
    };
  }
};
const receipt = async (store: Store, i: ManageSlackResponseInput): Promise<Row> => {
  const expectedKey = `${keyPrefix(i.install)}receipt:${i.channel}:${i.message_ts}`;
  const r = await store.raw(expectedKey);
  if (!r?.id || r.leaf_type !== 'slack_connector_receipt' || r.unique_key !== expectedKey)
    throw new Error('original_receipt_not_found');
  if (i.receipt_id && i.receipt_id !== r.id && i.receipt_id !== r.unique_key)
    throw new Error('receipt_reference_mismatch');
  const f = r.custom_fields ?? {};
  if (
    f[field('channel')] !== i.channel ||
    f[field('message_ts')] !== i.message_ts ||
    f[field('thread_ts')] !== (i.thread_ts || i.message_ts)
  )
    throw new Error('receipt_destination_mismatch');
  return r;
};
const triageData = async (api: DevRevClient, i: ManageSlackResponseInput): Promise<Evidence> => {
  if (!i.rationale?.trim() || !i.decision?.trim()) throw new Error('rationale_and_decision_required');
  if (i.rationale.length > 512 || i.decision.length > 128) throw new Error('decision_text_too_long');
  return {
    ...base(i),
    ...(await sessionFacts(api, i)),
    rationale: i.rationale,
    decision: i.decision,
    job_id: i.job_id || 'no-job',
    no_job: !i.job_id,
    // Replying about a job does not choose or replace its working session.
    acting_session: i.job_id ? (i.acting_session || 'unknown') : (i.agent_session_id ?? 'unknown'),
  };
};

const reconcile = async (
  store: Store,
  i: ManageSlackResponseInput,
  deps: SlackSendDeps
): Promise<ManageSlackResponseOutput> => {
  const confirmed = await store.read(keyFor(i, 'confirmed'));
  if (confirmed) return output('ok', 'Reply confirmed.', confirmed);
  const failed = await store.read(keyFor(i, 'failed'));
  if (failed) return output('error', 'Slack rejected the reply. It was not repeated.', failed);
  const intent = await store.read(keyFor(i, 'intent'));
  if (!intent) return output('unknown', 'No reply attempt is recorded.');
  let cursor: string | undefined;
  const matches = new Set<string>();
  try {
    const bot = (await deps.slack.auth.test()).user_id;
    if (!bot) return output('unknown', 'Slack identity could not be read.', intent);
    do {
      const p = await deps.slack.conversations.replies({
        channel: i.channel as string,
        ts: intent.data.thread_ts as string,
        cursor,
        limit: 200,
        include_all_metadata: true,
      });
      if (!p.ok) return output('unknown', 'Slack history could not be read.', intent);
      for (const m of p.messages ?? []) {
        const meta = m.metadata as { event_type?: string; event_payload?: Record<string, unknown> } | undefined;
        if (
          m.user === bot &&
          meta?.event_type === 'slack_workflow_response' &&
          meta.event_payload?.['response_key'] === intent.data.response_key &&
          meta.event_payload?.['attempt_id'] === intent.data.attempt_id &&
          m.ts
        )
          matches.add(m.ts);
      }
      cursor = p.response_metadata?.next_cursor || undefined;
    } while (cursor);
  } catch {
    return output('unknown', 'Slack history could not be read. No reply was repeated.', intent);
  }
  if (matches.size !== 1)
    return output(
      'unknown',
      matches.size
        ? 'Multiple matching replies need operator review.'
        : 'The reply result is still unknown. No reply was repeated.',
      intent
    );
  const c = await store.fact(keyFor(i, 'confirmed'), {
    ...intent.data,
    stage: 'confirmed',
    slack_ts: [...matches][0],
    confirmed_by: 'slack_history',
    timestamp: new Date().toISOString(),
  });
  return output('ok', 'Reply confirmed from Slack history.', c);
};

export const manageSlackResponse = async (
  action: SlackResponseAction,
  original: ManageSlackResponseInput,
  api: DevRevClient,
  deps: SlackSendDeps,
  member: string | undefined
): Promise<ManageSlackResponseOutput> => {
  const i = { ...original, response_event: original.response_event || 'initial' };
  if (!i.install || !i.channel || !i.message_ts || !/^[0-9]+\.[0-9]+$/.test(i.message_ts))
    return output('error', 'An exact incoming message and destination are required.');
  if (i.response_event.length > 128) return output('error', 'The response-event key is too long.');
  const viewer = await resolveStateViewer(api, member);
  if (!viewer?.stateRole)
    return output('error', 'Protected reply records are not accessible to the configured operator.');
  const store = new Store(api, viewer);
  if (action === 'prepare') {
    const r = await receipt(store, i);
    const text = String(r.custom_fields?.[field('text')] ?? '');
    const row = await store.fact(keyFor(i, 'prepared'), {
      ...base(i),
      receipt_id: r.id,
      stage: 'prepared',
      inbound_text_hash: hash(text),
    });
    return output('ok', 'Incoming request recorded.', row);
  }
  if (action === 'record_triage') {
    const r = await receipt(store, i);
    const row = await store.fact(keyFor(i, 'triaged'), {
      ...(await triageData(api, i)),
      receipt_id: r.id,
      stage: 'triaged',
    });
    return output('ok', 'Communication decision recorded.', row);
  }
  if (action === 'send') {
    const existing = await store.read(keyFor(i, 'confirmed'));
    if (existing) return output('ok', 'This reply is already confirmed. It was not repeated.', existing);
    if (await store.read(keyFor(i, 'intent'))) return reconcile(store, i, deps);
    if (i.workflow_mode !== 'workflow')
      return output('blocked', 'Explicit replies require workflow routing; no competing reply path was used.');
    if (!i.text?.trim()) return output('error', 'Reply text is required.');
    const r = await receipt(store, i);
    const data = { ...(await triageData(api, i)), receipt_id: r.id };
    await store.fact(keyFor(i, 'triaged'), { ...data, stage: 'triaged' });
    const nonce = randomUUID();
    const intentData = {
      ...data,
      stage: 'reply_attempted',
      response_key: hash(keyFor(i, 'intent')),
      writer_nonce: nonce,
      attempt_id: randomUUID(),
      reply_text_hash: hash(i.text),
    };
    const intent = await store.create(keyFor(i, 'intent'), intentData);
    if (!intent.won || !intent.row)
      return output('unknown', 'Reply ownership could not be confirmed. No reply was repeated.', intent.row);
    let result: Awaited<ReturnType<WebClient['chat']['postMessage']>>;
    try {
      result = await deps.slack.chat.postMessage({
        channel: i.channel,
        thread_ts: i.thread_ts || i.message_ts,
        text: i.text,
        metadata: {
          event_type: 'slack_workflow_response',
          event_payload: { response_key: intentData.response_key, attempt_id: intentData.attempt_id },
        },
        unfurl_links: false,
        unfurl_media: false,
      });
    } catch (e) {
      const slackError = e as { code?: string; data?: { ok?: boolean; error?: string } };
      if (slackError.code === 'slack_webapi_platform_error' && slackError.data?.ok === false) {
        const row = await store.fact(keyFor(i, 'failed'), {
          ...intentData,
          stage: 'failed',
          error_code: slackError.data.error || 'slack_rejected',
        });
        return output('error', 'Slack rejected the reply. It was not repeated.', row);
      }
      await store.fact(keyFor(i, 'unknown'), { ...intentData, stage: 'unknown', error_code: 'send_result_unknown' });
      return output(
        'unknown',
        'Slack did not return a trustworthy result. Reconciliation is required; no repeat was attempted.',
        intent.row
      );
    }
    if (!result.ok || !result.ts) {
      const row = await store.fact(keyFor(i, result.ok === false ? 'failed' : 'unknown'), {
        ...intentData,
        stage: result.ok === false ? 'failed' : 'unknown',
        error_code: result.error || 'missing_slack_confirmation',
      });
      return output(result.ok === false ? 'error' : 'unknown', 'No successful reply confirmation was returned.', row);
    }
    // Do not catch evidence failures as Slack failures. Intent remains fenced; history can recover
    // the actual post even if this confirmation write fails after Slack accepted it.
    const c = await store.fact(keyFor(i, 'confirmed'), {
      ...intentData,
      stage: 'confirmed',
      slack_ts: result.ts,
      confirmed_by: 'slack_response',
    });
    return output('ok', 'Reply sent and confirmed.', c);
  }
  if (action === 'reconcile' || action === 'get') return reconcile(store, i, deps);
  if (action === 'finalize') {
    const checked = await reconcile(store, i, deps);
    const triage = await store.read(keyFor(i, 'triaged'));
    let result = checked;
    if (!triage) result = output('unknown', 'The agent communication decision is missing.');
    else if (
      !checked.posted &&
      triage.data.decision === 'no_action' &&
      typeof triage.data.rationale === 'string' &&
      triage.data.rationale
    ) {
      result = output('ok', 'The agent explicitly chose no action and recorded why.', triage);
    }
    const row = await store.fact(keyFor(i, `finalized:${randomUUID()}`), {
      ...base(i),
      ...(await sessionFacts(api, i)),
      stage: 'finalized',
      outcome: result.outcome,
      posted: result.posted,
      slack_ts: result.slack_ts ?? 'unknown',
      reason: !triage
        ? 'missing_triage'
        : result.posted
          ? 'reply_confirmed'
          : triage.data.decision === 'no_action'
            ? 'explicit_no_action'
            : 'reply_unconfirmed',
    });
    return { ...result, record_id: row.id };
  }
  if (action === 'fail') {
    const c = await store.read(keyFor(i, 'confirmed'));
    if (c) return output('ok', 'The reply is confirmed; the upstream error was not treated as a missing reply.', c);
    const row = await store.fact(keyFor(i, `upstream_error:${randomUUID()}`), {
      ...base(i),
      ...(await sessionFacts(api, i)),
      stage: 'upstream_error',
      error_code: /^[a-zA-Z0-9_:-]{1,128}$/.test(i.error_code || '') ? i.error_code : 'upstream_error',
      send_state: (await store.read(keyFor(i, 'intent'))) ? 'unknown' : 'not_attempted',
    });
    return output('error', 'The workflow ended with an explicit error record. No automatic retry was made.', row);
  }
  return output('error', 'Unsupported reply-record action.');
};
