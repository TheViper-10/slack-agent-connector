import { WebClient } from '@slack/web-api';
import { type FunctionEvent } from '../../types';
import runSlackPoller from '../slack_poller';
import { manageSlackResponse } from './manage_slack_response';
import run from './index';
import { SlackResponseOperation } from './operation';

// Locates the real generated devrev.operation.OperationOutput protobuf encoder that the
// platform runner (Runtime.createExecuteOperationResult) feeds handler results into. We load
// it from its on-disk package location rather than mocking it, so this regression exercises
// actual SDK serialization behavior, not an assumption about it. If the package isn't present
// on a given machine/CI image, the encoder-specific checks are skipped rather than failing the
// suite or guessing at the contract.
type OperationOutputEncoder = {
  encode: (message: unknown) => { finish: () => Uint8Array };
};
const resolveOperationOutputEncoder = (): OperationOutputEncoder | undefined => {
  const candidatePaths = [
    '/Users/priyadharshanravichandran/DevRev/Github_Repos/hocuspocus-server/node_modules/@devrev/typescript-sdk-internal/dist/snap-ins/schema.pb.js',
  ];
  for (const candidate of candidatePaths) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(candidate) as { OperationOutput?: OperationOutputEncoder };
      if (mod.OperationOutput) return mod.OperationOutput;
    } catch {
      // Try the next candidate; absence is handled by skipping below.
    }
  }
  return undefined;
};
const OperationOutput = resolveOperationOutputEncoder();
const describeIfEncoderAvailable = OperationOutput ? describe : describe.skip;

jest.mock('@slack/web-api', () => ({ WebClient: jest.fn(() => ({})) }));
jest.mock('../slack_poller', () => ({ __esModule: true, default: jest.fn(async () => undefined) }));
jest.mock('./manage_slack_response', () => ({ manageSlackResponse: jest.fn() }));
const event = (): FunctionEvent => ({
  context: { dev_oid: 'test-org', snap_in_id: 'test-install', secrets: { service_account_token: 'test-token' } },
  execution_metadata: { devrev_endpoint: 'https://api.example.test', event_type: 'operation' },
  input_data: { event_sources: {}, global_values: { invoke_mode: 'workflow', act_as_user_id: 'test-user' },
    keyrings: { slack_connection: { secret: 'test-slack-token' } } },
  payload: { data: { node: 'manage_slack_response', action: 'prepare', channel: 'C1', message_ts: '1.000001', receipt_id: 'receipt-test' } },
});
beforeEach(() => jest.clearAllMocks());
it('reads native operation inputs from payload.data and returns native output values, never a hook envelope', async () => {
  jest.mocked(manageSlackResponse).mockResolvedValue({ outcome: 'ok', posted: false, record_id: 'record-test', summary: 'Request recorded.' });
  const result = await run([event()]);
  expect(manageSlackResponse).toHaveBeenCalledWith('prepare', expect.objectContaining({ channel: 'C1', receipt_id: 'receipt-test' }), expect.anything(), expect.anything(), 'test-user');
  expect(result).toEqual({
    output: { values: [expect.objectContaining({ outcome: 'ok', record_id: 'record-test' })] },
    summary: 'Request recorded.',
    status: 1,
    port_outputs: [],
  });
  expect(result).not.toHaveProperty('response');
  expect(WebClient).toHaveBeenCalledWith('test-slack-token', { retryConfig: { retries: 0 } });
  expect(runSlackPoller).not.toHaveBeenCalled();
});
it('marks an unconfirmed finalization as a native error rather than successful delivery', async () => {
  const e = event(); (e.payload['data'] as Record<string, unknown>)['action'] = 'finalize';
  jest.mocked(manageSlackResponse).mockResolvedValue({ outcome: 'unknown', posted: false, summary: 'Reply unconfirmed.' });
  expect(await run([e])).toEqual({ error: { message: 'Reply unconfirmed.', type: 0 }, summary: 'Reply unconfirmed.', status: 3, port_outputs: [] });
});
it('maps the native SDK operation run input rather than invoking an event function', async () => {
  const e = event(); e.payload = { input_port_name: 'input', data: {} };
  const operation = new SlackResponseOperation(e);
  jest.mocked(manageSlackResponse).mockResolvedValue({ outcome: 'ok', posted: false, summary: 'Request recorded.' });
  const result = await operation.run(operation.GetContext(), { action: 'prepare', channel: 'C1', message_ts: '1.000001', receipt_id: 'receipt-test' }, {});
  expect(manageSlackResponse).toHaveBeenCalledWith('prepare', expect.objectContaining({ channel: 'C1', receipt_id: 'receipt-test' }), expect.anything(), expect.anything(), 'test-user');
  expect(result.status).toBe(1);
});
it('keeps polling ticks on the unchanged poller path', async () => {
  const e = event(); e.execution_metadata.event_type = 'timer.tick'; e.payload = {};
  await run([e]);
  expect(runSlackPoller).toHaveBeenCalledWith([e]);
  expect(manageSlackResponse).not.toHaveBeenCalled();
});

// Incident regression: Runtime.createExecuteOperationResult hands the operation handler's
// return value straight to the generated devrev.operation.OperationOutput.encode(), whose
// for..of over `port_outputs` has no undefined guard. A handler result missing `port_outputs`
// throws `TypeError: message.port_outputs is not iterable` for every result (success and
// error alike) before any output ever reaches the AskAgent/reply path. These checks run the
// real encoder (not a mock) against both the success and the error results this handler can
// produce, and demonstrate that the pre-fix shape (no port_outputs) reproduces the exact
// reported failure.
describeIfEncoderAvailable('serialization into the real OperationOutput encoder (incident regression)', () => {
  it('encodes a successful manage_slack_response result without throwing', async () => {
    jest.mocked(manageSlackResponse).mockResolvedValue({ outcome: 'ok', posted: false, record_id: 'record-test', summary: 'Request recorded.' });
    const result = await run([event()]);
    expect(() => OperationOutput!.encode(result).finish()).not.toThrow();
  });

  it('encodes an unconfirmed/error manage_slack_response result without throwing', async () => {
    const e = event(); (e.payload['data'] as Record<string, unknown>)['action'] = 'finalize';
    jest.mocked(manageSlackResponse).mockResolvedValue({ outcome: 'unknown', posted: false, summary: 'Reply unconfirmed.' });
    const result = await run([e]);
    expect(() => OperationOutput!.encode(result).finish()).not.toThrow();
  });

  it('reproduces the live incident TypeError when port_outputs is absent, grounding the fix', () => {
    const preFixShape = { output: { values: [{ outcome: 'ok' }] }, summary: 'Request recorded.' };
    expect(() => OperationOutput!.encode(preFixShape).finish()).toThrow(/port_outputs is not iterable/);
  });
});
