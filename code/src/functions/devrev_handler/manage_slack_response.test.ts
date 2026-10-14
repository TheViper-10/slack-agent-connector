import axios from 'axios';
import type { WebClient } from '@slack/web-api';
import type { DevRevClient } from '../../clients/devrev';
import { manageSlackResponse, RESPONSE_KIND } from './manage_slack_response';

/**
 * Offline smoke for the current immutable-stage implementation: every stage is a distinct,
 * once-written fact row (no .update/.delete); a send intent is fenced via a 409-raced,
 * nonce-distinct create so concurrent callers settle on exactly one post; an ambiguous create
 * failure after the intent write never posts; a transport timeout after a possible post stays
 * unknown until a thread-history reconcile with no second post; a confirmation-write failure
 * after Slack accepted the post is still recovered from history; a missing-triage finalize
 * reports unknown, not silently ok; an explicit no_action is accepted with no post. No live calls.
 */
jest.mock('axios');
beforeEach(() => {
  jest.mocked(axios.isAxiosError).mockImplementation((e: unknown) => !!(e as { isAxiosError?: boolean })?.isAxiosError);
});

const FIELD = (name: string): string => `app_slack_agent_connector__${name}`;
const STATE_LEAF = 'slack_connector_state';
const RECEIPT_LEAF = 'slack_connector_receipt';
const CHANNEL = 'C1';
const MESSAGE_TS = '1700000000.000100';
const INSTALL = 'don:integration:dvrv-us-1:devo/1:snap_in/abc';

const httpError = (status: number) =>
  Object.assign(new Error(String(status)), { isAxiosError: true, response: { status } });

interface Row {
  custom_fields: Record<string, unknown>;
  id: string;
  leaf_type: string;
  unique_key: string;
}

/** Minimal custom-objects double: nonce-distinct 409-on-duplicate create, get-by-unique-key, real roles.list/session shapes. */
class FakeApi {
  private readonly byKey = new Map<string, Row>();
  private seq = 0;
  deleteCalls = 0;
  updateCalls = 0;
  readonly sessionGetCalls: unknown[] = [];

  seedReceipt(channel: string, messageTs: string, text: string): void {
    const key = `slack_agent_connector:abc:receipt:${channel}:${messageTs}`;
    this.byKey.set(key, {
      custom_fields: {
        [FIELD('channel')]: channel,
        [FIELD('message_ts')]: messageTs,
        [FIELD('text')]: text,
        [FIELD('thread_ts')]: messageTs,
      },
      id: `receipt-${++this.seq}`,
      leaf_type: RECEIPT_LEAF,
      unique_key: key,
    });
  }

  rows(): Row[] {
    return [...this.byKey.values()];
  }

  intentData(): { attempt_id: string; response_key: string } {
    const row = this.rows().find((r) => r.unique_key.endsWith(':intent'));
    return JSON.parse(String(row?.custom_fields[FIELD('status')]));
  }

  readonly post = jest.fn(async (path: string, raw: unknown) => {
    const body = raw as {
      custom_fields?: Record<string, unknown>;
      id?: string;
      leaf_type?: string;
      unique_key?: string;
    };
    if (path === 'roles.list') return { roles: [{ id: 'viewer-role', name: 'Viewer' }] };
    if (path === 'ai-agent.sessions.get') {
      this.sessionGetCalls.push(body);
      return { agent_session: { agent: 'agent-1' } };
    }
    if (path === 'custom-objects.get') {
      const row = this.byKey.get(body.unique_key ?? '');
      if (!row) throw httpError(404);
      return { custom_object: row };
    }
    if (path === 'custom-objects.create') {
      // Distinct writer_nonce per racing create means an identical-looking retry still collides
      // on unique_key: the server 409s the loser instead of silently deduping to a 201.
      const key = body.unique_key ?? '';
      if (this.byKey.has(key)) throw httpError(409);
      const id = `obj-${++this.seq}`;
      this.byKey.set(key, {
        custom_fields: body.custom_fields ?? {},
        id,
        leaf_type: body.leaf_type ?? STATE_LEAF,
        unique_key: key,
      });
      return { custom_object: { id } };
    }
    if (path === 'custom-objects.update') {
      this.updateCalls += 1;
      throw new Error('custom-objects.update must never be called by manageSlackResponse');
    }
    if (path === 'custom-objects.delete') {
      this.deleteCalls += 1;
      throw new Error('custom-objects.delete must never be called by manageSlackResponse');
    }
    throw new Error(`unexpected post: ${path}`);
  });

  client(): DevRevClient {
    return { post: this.post } as unknown as DevRevClient;
  }
}

const okSlack = (ts: string): WebClient =>
  ({ chat: { postMessage: jest.fn(async () => ({ ok: true, ts })) } }) as unknown as WebClient;
const historySlack = (attemptId: string, responseKey: string, ts: string): WebClient =>
  ({
    auth: { test: jest.fn(async () => ({ user_id: 'BOT1' })) },
    conversations: {
      replies: jest.fn(async () => ({
        messages: [
          {
            metadata: {
              event_payload: { attempt_id: attemptId, response_key: responseKey },
              event_type: 'slack_workflow_response',
            },
            ts,
            user: 'BOT1',
          },
        ],
        ok: true,
      })),
    },
  }) as unknown as WebClient;

const input = (overrides: Partial<Record<string, unknown>> = {}) => ({
  channel: CHANNEL,
  decision: 'answer the contact question directly',
  install: INSTALL,
  message_ts: MESSAGE_TS,
  rationale: 'no job needed; this is a contact-only question',
  text: 'Thanks for reaching out!',
  thread_ts: MESSAGE_TS,
  workflow_mode: 'workflow',
  ...overrides,
});

describe('manageSlackResponse smoke (current immutable-stage implementation)', () => {
  it('acknowledges an existing job without inventing or changing its working session; a repeat stays fenced', async () => {
    const api = new FakeApi();
    api.seedReceipt(CHANNEL, MESSAGE_TS, 'notify me when the PR is approved');
    const slack = okSlack('1700000001.000200');
    const acknowledgement = input({ job_id: 'job-1', agent_session_id: 'reply-session' });
    const result = await manageSlackResponse('send', acknowledgement, api.client(), { slack }, 'dev-1');
    expect(result.posted).toBe(true);
    const triaged = api.rows().find((row) => row.unique_key.endsWith(':triaged'))!;
    expect(JSON.parse(String(triaged.custom_fields[FIELD('status')]))).toMatchObject({
      job_id: 'job-1', acting_session: 'unknown', agent_session_id: 'reply-session', no_job: false,
    });
    await manageSlackResponse('send', acknowledgement, api.client(), { slack }, 'dev-1');
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(api.updateCalls).toBe(0);
    expect(api.deleteCalls).toBe(0);
  });
  it('persists only kind "response" rows, never updates/deletes, and resolves sessions by id', async () => {
    const api = new FakeApi();
    api.seedReceipt(CHANNEL, MESSAGE_TS, 'hello');
    await manageSlackResponse('prepare', input(), api.client(), { slack: okSlack('ignored') }, 'dev-1');
    await manageSlackResponse(
      'send',
      input({ agent_session_id: 'sess-1' }),
      api.client(),
      { slack: okSlack('1700000001.000200') },
      'dev-1'
    );

    expect(api.updateCalls).toBe(0);
    expect(api.deleteCalls).toBe(0);
    const rows = api.rows().filter((r) => r.leaf_type === STATE_LEAF);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.custom_fields[FIELD('kind')]).toBe(RESPONSE_KIND);
    expect(api.sessionGetCalls).toContainEqual({ id: 'sess-1' });
  });

  it('two concurrent sends after prepare yield exactly one post; the loser is fenced, not resent', async () => {
    const api = new FakeApi();
    api.seedReceipt(CHANNEL, MESSAGE_TS, 'hello');
    await manageSlackResponse('prepare', input(), api.client(), { slack: okSlack('ignored') }, 'dev-1');
    const slack = okSlack('1700000001.000200');

    const [first, second] = await Promise.all([
      manageSlackResponse('send', input(), api.client(), { slack }, 'dev-1'),
      manageSlackResponse('send', input(), api.client(), { slack }, 'dev-1'),
    ]);

    expect((slack.chat.postMessage as jest.Mock).mock.calls.length).toBe(1);
    expect([first.outcome, second.outcome].filter((o) => o === 'ok').length).toBe(1);
    expect(api.rows().filter((r) => r.unique_key.endsWith(':intent')).length).toBe(1);
  });

  it('an ambiguous create failure (500) after storing the intent never posts', async () => {
    const api = new FakeApi();
    api.seedReceipt(CHANNEL, MESSAGE_TS, 'hello');
    const original = api.post.getMockImplementation()!;
    api.post.mockImplementation(async (path: string, body: unknown) => {
      if (
        path === 'custom-objects.create' &&
        String((body as { unique_key?: string }).unique_key ?? '').includes(':intent')
      ) {
        await original(path, body);
        throw httpError(500);
      }
      return original(path, body);
    });
    const slack = okSlack('1700000001.000200');

    const result = await manageSlackResponse('send', input(), api.client(), { slack }, 'dev-1');

    expect(result.outcome).toBe('unknown');
    expect(result.posted).toBe(false);
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });

  it('a Slack timeout after the post stays unknown; a later send reconciles via history with no second post', async () => {
    const api = new FakeApi();
    api.seedReceipt(CHANNEL, MESSAGE_TS, 'hello');
    const timeout = Object.assign(new Error('timeout'), { isAxiosError: true, code: 'ECONNABORTED' });
    const timingOutSlack = {
      chat: {
        postMessage: jest.fn(async () => {
          throw timeout;
        }),
      },
    } as unknown as WebClient;

    const sent = await manageSlackResponse('send', input(), api.client(), { slack: timingOutSlack }, 'dev-1');
    expect(sent.outcome).toBe('unknown');
    expect(sent.posted).toBe(false);

    const { attempt_id, response_key } = api.intentData();
    const reconciled = await manageSlackResponse(
      'send',
      input(),
      api.client(),
      { slack: historySlack(attempt_id, response_key, '1700000002.000300') },
      'dev-1'
    );

    expect(reconciled.outcome).toBe('ok');
    expect(reconciled.slack_ts).toBe('1700000002.000300');
    expect(api.updateCalls).toBe(0);
  });

  it('a confirmation-write failure after Slack accepted the post is still recovered from history', async () => {
    const api = new FakeApi();
    api.seedReceipt(CHANNEL, MESSAGE_TS, 'hello');
    const slack = okSlack('1700000001.000200');
    const original = api.post.getMockImplementation()!;
    let failConfirm = true;
    api.post.mockImplementation(async (path: string, body: unknown) => {
      const key = String((body as { unique_key?: string }).unique_key ?? '');
      if (path === 'custom-objects.create' && key.endsWith(':confirmed') && failConfirm) {
        failConfirm = false;
        throw httpError(500);
      }
      return original(path, body);
    });

    await expect(manageSlackResponse('send', input(), api.client(), { slack }, 'dev-1')).rejects.toThrow(
      'evidence_write_unconfirmed'
    );
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);

    const { attempt_id, response_key } = api.intentData();
    const reconciled = await manageSlackResponse(
      'reconcile',
      input(),
      api.client(),
      { slack: historySlack(attempt_id, response_key, '1700000001.000200') },
      'dev-1'
    );

    expect(reconciled.outcome).toBe('ok');
    expect(reconciled.slack_ts).toBe('1700000001.000200');
  });

  it('finalize with a missing triage decision reports unknown, not silently ok', async () => {
    const api = new FakeApi();
    api.seedReceipt(CHANNEL, MESSAGE_TS, 'hello');
    await manageSlackResponse('prepare', input(), api.client(), { slack: okSlack('ignored') }, 'dev-1');

    const result = await manageSlackResponse('finalize', input(), api.client(), { slack: okSlack('ignored') }, 'dev-1');

    expect(result.outcome).toBe('unknown');
    expect(result.summary).toMatch(/missing/);
  });

  it('an explicit agent-authored no_action with a rationale is accepted with no post, no intent', async () => {
    const api = new FakeApi();
    api.seedReceipt(CHANNEL, MESSAGE_TS, 'hello');
    const noActionInput = input({ decision: 'no_action', rationale: 'the customer already resolved this themselves' });
    await manageSlackResponse('record_triage', noActionInput, api.client(), { slack: okSlack('ignored') }, 'dev-1');

    const result = await manageSlackResponse(
      'finalize',
      noActionInput,
      api.client(),
      { slack: okSlack('ignored') },
      'dev-1'
    );

    expect(result.outcome).toBe('ok');
    expect(result.posted).toBe(false);
    expect(api.rows().some((r) => r.unique_key.endsWith(':intent'))).toBe(false);
  });
});
