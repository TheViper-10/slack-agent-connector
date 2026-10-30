import { createHmac } from 'node:crypto';

import { SlackPoller } from '../../poller/poll';
import type { ClaimResult, StateRecord, StateStore } from '../../poller/state';
import type { FunctionEvent } from '../../types';
import { handleSlackEvent } from './index';

const SECRET = 'signing-secret';

const sign = (ts: string, raw: string, secret = SECRET): string =>
  `v0=${createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')}`;

const makeEvent = (secret: string, signatureSecret = SECRET): FunctionEvent => {
  const ts = String(Math.floor(Date.now() / 1000));
  const body_raw = JSON.stringify({
    api_app_id: 'A1',
    event: { channel: 'C1', text: '<@UBOT> run tests', ts: '1790000000.000100', type: 'app_mention', user: 'U1' },
    type: 'event_callback',
  });
  return {
    context: { dev_oid: 'o', secrets: { service_account_token: 't' }, snap_in_id: 'inst-1' },
    execution_metadata: { devrev_endpoint: 'https://x', event_type: 'custom:slack_events' },
    input_data: {
      event_sources: {},
      global_values: { slack_app_id: 'A1' },
      keyrings: secret ? { slack_signing_secret: { secret } } : {},
    },
    payload: {
      body_raw,
      headers: { 'X-Slack-Request-Timestamp': ts, 'X-Slack-Signature': sign(ts, body_raw, signatureSecret) },
    },
  };
};

describe('slack_events ingress', () => {
  const setup = (allowedChannels?: Set<string>) => {
    const claimed = new Set<string>();
    const claimReceipt = jest.fn(async (channel: string, messageTs: string): Promise<ClaimResult> => {
      const key = `${channel}:${messageTs}`;
      if (claimed.has(key)) return { claimed: false, existing: { claimedAt: 0, id: 'r1', status: 'done' } };
      claimed.add(key);
      return { claimed: true, receipt: { claimedAt: 0, id: 'r1', status: 'claimed' } };
    });
    const store = {
      claimReceipt,
      completeReceipt: jest.fn(async () => undefined),
      getState: jest.fn(async () => undefined),
      saveState: jest.fn(async (r: StateRecord) => r),
    } as unknown as StateStore;
    const poller = new SlackPoller({
      allowedChannels,
      botUserId: 'UBOT',
      buildReceiptPayload: async () => ({ parentTs: '', sender: 'U1', senderName: '', text: '', threadContext: '' }),
      dispatch: jest.fn(),
      installId: 'inst-1',
      isDispatched: jest.fn(),
      log: () => undefined,
      slack: {} as never,
      store,
    });
    return { claimReceipt, build: async () => poller };
  };

  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('claims one receipt for a validly signed mention, and none for a repeated delivery', async () => {
    const { build, claimReceipt } = setup();
    const event = makeEvent(SECRET);
    await expect(handleSlackEvent(event, build)).resolves.toBe('dispatched');
    await expect(handleSlackEvent(event, build)).resolves.toBe('duplicate');
    expect(claimReceipt).toHaveBeenCalledTimes(2);
  });

  it('drops a bad signature or a missing secret without touching the receipt store', async () => {
    const { build, claimReceipt } = setup();
    await expect(handleSlackEvent(makeEvent(SECRET, 'other-secret'), build)).resolves.toBe('dropped');
    await expect(handleSlackEvent(makeEvent(''), build)).resolves.toBe('dropped');
    expect(claimReceipt).not.toHaveBeenCalled();
  });

  it('ignores a channel outside the channel allowlist', async () => {
    const { build, claimReceipt } = setup(new Set(['C9']));
    await expect(handleSlackEvent(makeEvent(SECRET), build)).resolves.toBe('ignored');
    expect(claimReceipt).not.toHaveBeenCalled();
  });
});
