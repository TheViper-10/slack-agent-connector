import axios from 'axios';

import type { DevRevClient } from '../../clients/devrev';
import type { FunctionEvent } from '../../types';
import run, { executingCommentRef, handleEvent, isDispatchedIn } from './index';

jest.mock('axios');
const mockedIsAxiosError = jest.mocked(axios.isAxiosError);

const baseEvent = (overrides: Partial<FunctionEvent['input_data']> = {}): FunctionEvent => ({
  context: {
    dev_oid: 'don:identity:dvrv-us-1:devo/1',
    secrets: { service_account_token: 'svc-token' },
    snap_in_id: 'don:integration:dvrv-us-1:devo/1:snap_in/1',
  },
  execution_metadata: { devrev_endpoint: 'https://api.dev.devrev-eng.ai', event_type: 'timer.tick' },
  input_data: {
    event_sources: {},
    global_values: { slack_bot_user_id: 'UBOT' },
    resources: { keyrings: { slack_connection: { secret: 'xoxb-test' } } },
    ...overrides,
  },
  payload: {},
});

describe('slack_poller', () => {
  it('uses the same external_ref the invoke logic writes on the executing comment', () => {
    expect(executingCommentRef('D1', '1.1')).toBe('slack:D1:1.1');
  });

  it('reports a dispatched message when the executing comment exists in the DM', async () => {
    const post = jest.fn().mockResolvedValue({ timeline_entry: { id: 'c-1' } });
    const check = isDispatchedIn({ post } as unknown as DevRevClient);

    await expect(check('dm-1', 'D1', '1.1')).resolves.toBe(true);
    expect(post).toHaveBeenCalledWith('timeline-entries.get', { external_ref: 'slack:D1:1.1', id: 'dm-1' });
  });

  it('reports not dispatched on 404 and rethrows other errors', async () => {
    mockedIsAxiosError.mockReturnValue(true);
    const notFound = { post: jest.fn().mockRejectedValue({ response: { status: 404 } }) } as unknown as DevRevClient;
    await expect(isDispatchedIn(notFound)('dm-1', 'D1', '1.1')).resolves.toBe(false);

    const forbidden = { post: jest.fn().mockRejectedValue({ response: { status: 403 } }) } as unknown as DevRevClient;
    await expect(isDispatchedIn(forbidden)('dm-1', 'D1', '1.1')).rejects.toEqual({ response: { status: 403 } });
  });

  it('requires the Slack connection and the activation-discovered bot user id', async () => {
    await expect(handleEvent(baseEvent({ resources: { keyrings: {} } }))).rejects.toThrow(
      'Slack connection is required'
    );
    await expect(handleEvent(baseEvent({ global_values: {} }))).rejects.toThrow('slack_bot_user_id is not set');
  });

  it('logs the failing call with secrets redacted and rethrows', async () => {
    mockedIsAxiosError.mockReturnValue(false);
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const event = baseEvent({ global_values: {} });

    await expect(run([event])).rejects.toThrow('slack_bot_user_id is not set');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('slack poll failed: slack_bot_user_id is not set'));
    expect(log.mock.calls.flat().join(' ')).not.toContain('xoxb-test');
    log.mockRestore();
  });
});
