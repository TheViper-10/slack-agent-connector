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
  ({
    auth: { test: jest.fn(async () => ({ user_id: 'BOT1' })) },
    chat: { postMessage: jest.fn(async () => ({ ok: true, ts })) },
  }) as unknown as WebClient;
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
  expected_bot_user_id: 'BOT1',
  install: INSTALL,
  message_ts: MESSAGE_TS,
  rationale: 'no job needed; this is a contact-only question',
  text: 'Thanks for reaching out!',
  thread_ts: MESSAGE_TS,
  workflow_mode: 'workflow',
  ...overrides,
});

describe('manageSlackResponse bot identity guard', () => {
  it('blocks send, post_root and reply when the token posts as another bot or the install has no bot id, and posts nothing', async () => {
    const api = new FakeApi();
    api.seedReceipt(CHANNEL, MESSAGE_TS, 'hello');
    const slack = okSlack('1700000009.000900');
    const other = input({ expected_bot_user_id: 'BOT2' });
    const root = { response_event: 'ticket-9', message_ts: undefined, thread_ts: undefined };
    const send = await manageSlackResponse('send', other, api.client(), { slack }, 'dev-1');
    expect(send).toMatchObject({ outcome: 'blocked', posted: false });
    expect(send.summary).toContain(`bot_identity_mismatch: token posts as BOT1, install ${INSTALL} expects BOT2`);
    const posted = await manageSlackResponse('post_root', { ...other, ...root }, api.client(), { slack }, 'dev-1');
    expect(posted.outcome).toBe('blocked');
    const replied = await manageSlackResponse(
      'reply',
      { ...other, thread_ts: MESSAGE_TS, message_ts: undefined, skill_call_id: 'call-1' },
      api.client(),
      { slack },
      'dev-1'
    );
    expect(replied.outcome).toBe('blocked');
    const unrecorded = await manageSlackResponse(
      'send',
      input({ expected_bot_user_id: undefined }),
      api.client(),
      { slack },
      'dev-1'
    );
    expect(unrecorded).toMatchObject({ outcome: 'blocked', posted: false });
    expect(unrecorded.summary).toContain('bot_identity_unrecorded');
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
    expect(api.rows()).toHaveLength(1);
  });
});

describe('manageSlackResponse post_root', () => {
  const ROOT = { channel: CHANNEL, install: INSTALL, response_event: 'ticket-42', text: 'Starting work on Ticket 42.' };
  const rootSlack = (ts: string): WebClient =>
    ({
      auth: { test: jest.fn(async () => ({ user_id: 'BOT1' })) },
      chat: { postMessage: jest.fn(async () => ({ ok: true, ts })) },
      conversations: { history: jest.fn(async () => ({ messages: [], ok: true })) },
    }) as unknown as WebClient;

  it('posts one top-level message with no thread_ts and records it under a root key', async () => {
    const api = new FakeApi();
    api.seedReceipt(CHANNEL, MESSAGE_TS, 'unused');
    const slack = rootSlack('1700000002.000300');
    const result = await manageSlackResponse(
      'post_root',
      input({ ...ROOT, message_ts: undefined, thread_ts: undefined, workflow_mode: 'workflow' }),
      api.client(),
      { slack },
      'dev-1'
    );
    expect(result).toMatchObject({ outcome: 'ok', posted: true, slack_ts: '1700000002.000300' });
    const call = (slack.chat.postMessage as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(call).not.toHaveProperty('thread_ts');
    expect(call).toMatchObject({ channel: CHANNEL, text: ROOT.text });
    const again = await manageSlackResponse(
      'post_root',
      input({ ...ROOT, message_ts: undefined, thread_ts: undefined, workflow_mode: 'workflow' }),
      api.client(),
      { slack },
      'dev-1'
    );
    expect(again.posted).toBe(true);
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it('posts into the given thread when thread_ts is set', async () => {
    const api = new FakeApi();
    const slack = rootSlack('1700000003.000400');
    const result = await manageSlackResponse(
      'post_root',
      input({ ...ROOT, message_ts: undefined, thread_ts: '1700000001.000100', workflow_mode: 'workflow' }),
      api.client(),
      { slack },
      'dev-1'
    );
    expect(result).toMatchObject({ outcome: 'ok', posted: true, slack_ts: '1700000003.000400' });
    const call = (slack.chat.postMessage as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(call).toMatchObject({ channel: CHANNEL, text: ROOT.text, thread_ts: '1700000001.000100' });
  });

  it('refuses to post without a unique response_event key or without workflow routing', async () => {
    const api = new FakeApi();
    const slack = rootSlack('1.000001');
    const noKey = await manageSlackResponse(
      'post_root',
      input({ ...ROOT, response_event: undefined, workflow_mode: 'workflow' }),
      api.client(),
      { slack },
      'dev-1'
    );
    expect(noKey.outcome).toBe('error');
    const direct = await manageSlackResponse(
      'post_root',
      input({ ...ROOT, workflow_mode: 'direct' }),
      api.client(),
      { slack },
      'dev-1'
    );
    expect(direct.outcome).toBe('blocked');
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });

  it('a timeout after a possible root post stays unknown and reconciles from channel history, never reposts', async () => {
    const api = new FakeApi();
    const postMessage = jest.fn(async () => {
      throw new Error('socket timeout');
    });
    const slack = { ...rootSlack('1.0'), chat: { postMessage } } as unknown as WebClient;
    const first = await manageSlackResponse(
      'post_root',
      input({ ...ROOT, message_ts: undefined, thread_ts: undefined, workflow_mode: 'workflow' }),
      api.client(),
      { slack },
      'dev-1'
    );
    expect(first.outcome).toBe('unknown');
    const intent = JSON.parse(
      String(api.rows().find((r) => r.unique_key.endsWith(':intent'))?.custom_fields[FIELD('status')])
    );
    const history = jest.fn(async () => ({
      messages: [
        {
          metadata: {
            event_payload: { attempt_id: intent.attempt_id, response_key: intent.response_key },
            event_type: 'slack_workflow_response',
          },
          ts: '1700000003.000400',
          user: 'BOT1',
        },
      ],
      ok: true,
    }));
    const recon = { ...rootSlack('1.0'), conversations: { history } } as unknown as WebClient;
    const second = await manageSlackResponse(
      'post_root',
      input({ ...ROOT, message_ts: undefined, thread_ts: undefined, workflow_mode: 'workflow' }),
      api.client(),
      { slack: recon },
      'dev-1'
    );
    expect(second).toMatchObject({ outcome: 'ok', posted: true, slack_ts: '1700000003.000400' });
    expect(postMessage).toHaveBeenCalledTimes(1);
  });
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
      job_id: 'job-1',
      acting_session: 'unknown',
      agent_session_id: 'reply-session',
      no_job: false,
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
      auth: { test: jest.fn(async () => ({ user_id: 'BOT1' })) },
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

describe('manageSlackResponse reply action', () => {
  const THREAD = '1700000001.000100';
  const REPLY = { message_ts: undefined, thread_ts: THREAD, skill_call_id: 'call-1', text: 'Following up.' };
  const threadSlack = (ts: string): WebClient =>
    ({
      auth: { test: jest.fn(async () => ({ user_id: 'BOT1' })) },
      chat: { postMessage: jest.fn(async () => ({ ok: true, ts })) },
      conversations: {
        history: jest.fn(async () => ({ messages: [], ok: true })),
        replies: jest.fn(async () => ({ messages: [], ok: true })),
      },
    }) as unknown as WebClient;
  const receiptReads = (api: FakeApi): number =>
    api.post.mock.calls.filter(
      ([path, body]) =>
        path === 'custom-objects.get' && String((body as { unique_key?: string }).unique_key).includes(':receipt:')
    ).length;
  const rootRows = (api: FakeApi) => api.rows().filter((r) => r.unique_key.includes(':root:'));

  it('posts into the thread, records under a root key, reads no receipt', async () => {
    const api = new FakeApi();
    const slack = threadSlack('1700000005.000500');
    const r = await manageSlackResponse('reply', input(REPLY), api.client(), { slack }, 'dev-1');
    expect(r).toMatchObject({
      outcome: 'ok',
      posted: true,
      slack_ts: '1700000005.000500',
      route: 'thread',
      summary: 'Reply sent (thread route).',
    });
    expect(r.message_id).toBeTruthy();
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: CHANNEL, thread_ts: THREAD })
    );
    expect(receiptReads(api)).toBe(0);
    expect(rootRows(api).map((x) => x.unique_key)).toEqual(
      expect.arrayContaining([expect.stringContaining(`:root:${CHANNEL}:reply:${THREAD}:call-1:confirmed`)])
    );
    expect(api.rows().some((x) => x.unique_key.includes(':response:'))).toBe(false);
  });

  it('a repeat with the same skill_call_id does not repost', async () => {
    const api = new FakeApi();
    const slack = threadSlack('1700000005.000500');
    await manageSlackResponse('reply', input(REPLY), api.client(), { slack }, 'dev-1');
    const again = await manageSlackResponse('reply', input(REPLY), api.client(), { slack }, 'dev-1');
    expect(again.posted).toBe(true);
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it('a different skill_call_id in the same thread posts again', async () => {
    const api = new FakeApi();
    const slack = threadSlack('1700000005.000500');
    await manageSlackResponse('reply', input(REPLY), api.client(), { slack }, 'dev-1');
    const second = await manageSlackResponse(
      'reply',
      input({ ...REPLY, skill_call_id: 'call-2', text: 'Second.' }),
      api.client(),
      { slack },
      'dev-1'
    );
    expect(second.outcome).toBe('ok');
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(second.summary).toBe('Reply sent (thread route).');
  });

  it('a timeout then reconcile finds the reply via conversations.replies (with paging), never reposts, never reads history', async () => {
    const api = new FakeApi();
    const postMessage = jest.fn(async () => {
      throw new Error('socket timeout');
    });
    const first = await manageSlackResponse(
      'reply',
      input(REPLY),
      api.client(),
      { slack: { ...threadSlack('1.0'), chat: { postMessage } } as unknown as WebClient },
      'dev-1'
    );
    expect(first.outcome).toBe('unknown');
    const intent = JSON.parse(
      String(api.rows().find((r) => r.unique_key.endsWith(':intent'))?.custom_fields[FIELD('status')])
    );
    const hit = {
      metadata: {
        event_payload: { attempt_id: intent.attempt_id, response_key: intent.response_key },
        event_type: 'slack_workflow_response',
      },
      ts: '1700000007.000700',
      user: 'BOT1',
    };
    const replies = jest
      .fn()
      .mockResolvedValueOnce({
        messages: [{ ts: THREAD, user: 'U1' }],
        ok: true,
        response_metadata: { next_cursor: 'c2' },
      })
      .mockResolvedValueOnce({ messages: [hit], ok: true });
    const history = jest.fn(async () => ({ messages: [], ok: true }));
    const slack = {
      ...threadSlack('1.0'),
      chat: { postMessage },
      conversations: { history, replies },
    } as unknown as WebClient;
    const second = await manageSlackResponse('reply', input(REPLY), api.client(), { slack }, 'dev-1');
    expect(second).toMatchObject({ outcome: 'ok', posted: true, slack_ts: '1700000007.000700' });
    expect(replies).toHaveBeenCalledTimes(2);
    expect(replies.mock.calls[0][0]).toMatchObject({ channel: CHANNEL, ts: THREAD });
    expect(history).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('is refused without thread_ts or without a trusted skill_call_id', async () => {
    const api = new FakeApi();
    const slack = threadSlack('1.000001');
    for (const o of [
      { ...REPLY, thread_ts: undefined },
      { ...REPLY, skill_call_id: undefined },
      { ...REPLY, skill_call_id: 'unknown' },
    ]) {
      const r = await manageSlackResponse('reply', input(o), api.client(), { slack }, 'dev-1');
      expect(r.outcome).toBe('error');
    }
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
    expect(api.rows()).toHaveLength(0);
  });

  it('with message_ts and no receipt still fails original_receipt_not_found and posts nothing', async () => {
    const api = new FakeApi();
    const slack = threadSlack('1.000001');
    await expect(
      manageSlackResponse('reply', input({ skill_call_id: 'call-1' }), api.client(), { slack }, 'dev-1')
    ).rejects.toThrow('original_receipt_not_found');
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });

  it('send with message_ts and a receipt is unchanged: response key, receipt read, finalize sees it', async () => {
    const api = new FakeApi();
    api.seedReceipt(CHANNEL, MESSAGE_TS, 'hi');
    const slack = threadSlack('1700000009.000900');
    const r = await manageSlackResponse('reply', input({ skill_call_id: 'call-1' }), api.client(), { slack }, 'dev-1');
    expect(r).toMatchObject({ posted: true, route: 'receipt' });
    expect(rootRows(api)).toHaveLength(0);
    const f = await manageSlackResponse('finalize', input(), api.client(), { slack }, 'dev-1');
    expect(f).toMatchObject({ outcome: 'ok', posted: true });
  });

  it('a reply under a root key is invisible to message_ts-keyed get/finalize (documented limit)', async () => {
    const api = new FakeApi();
    api.seedReceipt(CHANNEL, MESSAGE_TS, 'hi');
    const slack = threadSlack('1700000005.000500');
    await manageSlackResponse('reply', input(REPLY), api.client(), { slack }, 'dev-1');
    const g = await manageSlackResponse('get', input(), api.client(), { slack }, 'dev-1');
    expect(g.outcome).toBe('unknown');
    const f = await manageSlackResponse('finalize', input(), api.client(), { slack }, 'dev-1');
    expect(f.posted).toBe(false);
  });
});

describe('manageSlackResponse thinking reaction', () => {
  const reactSlack = (ts: string, remove = jest.fn(async () => ({ ok: true }))) =>
    ({
      auth: { test: jest.fn(async () => ({ user_id: 'BOT1' })) },
      chat: { postMessage: jest.fn(async () => ({ ok: true, ts })) },
      conversations: {
        history: jest.fn(async () => ({ messages: [], ok: true })),
        replies: jest.fn(async () => ({ messages: [], ok: true })),
      },
      reactions: { remove },
    }) as unknown as WebClient;
  const removed = (slack: WebClient) => (slack.reactions.remove as jest.Mock).mock.calls.map(([a]) => a);

  it('removes the reaction from the incoming message once a send is confirmed', async () => {
    const api = new FakeApi();
    api.seedReceipt(CHANNEL, MESSAGE_TS, 'hi');
    const slack = reactSlack('1700000009.000900');
    const r = await manageSlackResponse(
      'send',
      input({ workflow_mode: 'workflow', text: 'Done.' }),
      api.client(),
      { slack },
      'dev-1'
    );
    expect(r.posted).toBe(true);
    expect(removed(slack)).toEqual([{ channel: CHANNEL, name: 'hourglass_flowing_sand', timestamp: MESSAGE_TS }]);
  });

  it('removes it for reply with message_ts, finalize and fail, but not for prepare or an unposted send', async () => {
    const api = new FakeApi();
    api.seedReceipt(CHANNEL, MESSAGE_TS, 'hi');
    const slack = reactSlack('1700000009.000900');
    await manageSlackResponse('prepare', input(), api.client(), { slack }, 'dev-1');
    await manageSlackResponse('send', input({ text: '' }), api.client(), { slack }, 'dev-1');
    expect(removed(slack)).toHaveLength(0);
    await manageSlackResponse(
      'reply',
      input({ workflow_mode: 'workflow', skill_call_id: 'c1', text: 'Hi.' }),
      api.client(),
      { slack },
      'dev-1'
    );
    expect(removed(slack)).toHaveLength(1);
    await manageSlackResponse('finalize', input(), api.client(), { slack }, 'dev-1');
    await manageSlackResponse('fail', input({ response_event: 'other' }), api.client(), { slack }, 'dev-1');
    expect(removed(slack)).toHaveLength(3);
  });

  it('never touches reactions for a thread reply without message_ts', async () => {
    const api = new FakeApi();
    const slack = reactSlack('1700000005.000500');
    await manageSlackResponse(
      'reply',
      input({ message_ts: undefined, thread_ts: '1700000001.000100', skill_call_id: 'c1', text: 'Hi.' }),
      api.client(),
      { slack },
      'dev-1'
    );
    expect(removed(slack)).toHaveLength(0);
  });

  it('a failing or missing reactions.remove never changes the recorded outcome', async () => {
    const api = new FakeApi();
    api.seedReceipt(CHANNEL, MESSAGE_TS, 'hi');
    const failing = reactSlack(
      '1700000009.000900',
      jest.fn(async () => {
        throw new Error('missing_scope');
      })
    );
    const r = await manageSlackResponse(
      'send',
      input({ workflow_mode: 'workflow', text: 'Done.' }),
      api.client(),
      { slack: failing },
      'dev-1'
    );
    expect(r).toMatchObject({ outcome: 'ok', posted: true });
    const noReactions = { ...reactSlack('1.0'), reactions: undefined } as unknown as WebClient;
    const f = await manageSlackResponse('finalize', input(), api.client(), { slack: noReactions }, 'dev-1');
    expect(f.outcome).toBe('ok');
  });
});
