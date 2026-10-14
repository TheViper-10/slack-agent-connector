import { DevRevClient } from '../../clients/devrev';
import { manageSlackResponse } from '../devrev_handler/manage_slack_response';
import run from '../devrev_handler';
import type { FunctionEvent } from '../../types';

jest.mock('@slack/web-api', () => ({ WebClient: jest.fn(() => ({})) }));
jest.mock('../../clients/devrev', () => ({ DevRevClient: jest.fn(() => ({ post: jest.fn(async () => ({ snap_in: { inputs_values: { invoke_mode: 'workflow', agent_id: 'agent-test', act_as_user_id: 'operator-test' } } })) })) }));
jest.mock('../devrev_handler/manage_slack_response', () => ({ manageSlackResponse: jest.fn(async () => ({ outcome: 'ok', posted: false, summary: 'Incoming request recorded.' })) }));

it('uses operation resources and caller identity, reading installed configuration when globals are empty', async () => {
  const event = { context: { dev_oid: 'org-test', snap_in_id: '', secrets: { access_token: 'caller-test' } }, execution_metadata: { devrev_endpoint: 'https://api.example.test', event_type: 'operation' }, input_data: { global_values: {}, resources: { keyrings: { slack_connection: { secret: 'slack-test' } } } }, payload: { data: { snap_in_id: 'install-test', node: 'manage_slack_response', action: 'prepare', channel: 'C1', message_ts: '1.000001' } } } as unknown as FunctionEvent;
  const result = await run([event]);
  expect(DevRevClient).toHaveBeenCalledWith('https://api.example.test', 'caller-test');
  expect(manageSlackResponse).toHaveBeenCalledWith('prepare', expect.objectContaining({ install: 'install-test', workflow_mode: 'workflow', agent_id: 'agent-test' }), expect.anything(), expect.anything(), 'operator-test');
  expect(result?.status).toBe(1);
  expect(result?.port_outputs).toEqual([]);
});
