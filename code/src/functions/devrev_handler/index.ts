import axios from 'axios';
import { OperationOutput } from '@devrev/typescript-sdk/dist/snap-ins';
import { WebClient } from '@slack/web-api';
import { relayAsyncAgentResponse, relayAgentReply } from '../../agent/reply';
import { DevRevClient } from '../../clients/devrev';
import { type FunctionEvent, getKeyring } from '../../types';
import runSlackPoller from '../slack_poller';
import { type ManageSlackResponseInput, manageSlackResponse, type SlackResponseAction } from './manage_slack_response';

// Native workflow operations use OperationOutput, not the HTTP-style hook response envelope.
// The platform runner feeds this object directly into the SDK's generated OperationOutput
// encoder (devrev.operation.OperationOutput, schema.pb.ts), whose encode() does an
// unconditional `for (const v of message.port_outputs)` with no default/guard. port_outputs
// is a required (non-optional) array field on the wire contract, so every returned object
// must include it (empty array when only the default output port is used) or the encoder
// throws `TypeError: message.port_outputs is not iterable` for both success and error results.
export interface WorkflowOperationOutput {
  output?: { values: Array<Record<string, unknown>> };
  error?: { message: string; type: number };
  summary?: string;
  // SDK OperationOutput_ExecutionStatus: Completed=1, Errored=3. Never leave a terminal call Unknown.
  status: 1 | 3;
  port_outputs: never[];
}
const EMPTY_PORT_OUTPUTS: never[] = [];
const operationData = (event: FunctionEvent): Record<string, unknown> => {
  const data = event.payload['data'];
  return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {};
};

export const handleEvent = async (event: FunctionEvent): Promise<void> => {
  const slackToken = getKeyring(event, 'slack_connection')?.secret;
  if (!slackToken) throw new Error('Slack connection is required');
  const devrev = new DevRevClient(event.execution_metadata.devrev_endpoint, event.context.secrets.service_account_token);
  const slack = new WebClient(slackToken);
  if (event.execution_metadata.event_type === 'ai_agent_response' || event.payload['ai_agent_response']) {
    await relayAsyncAgentResponse(event, devrev, slack);
    return;
  }
  await relayAgentReply(event, devrev, slack);
};

export const handleManageSlackResponse = async (event: FunctionEvent): Promise<WorkflowOperationOutput> => {
  const data = operationData(event);
  const slackToken = getKeyring(event, 'slack_connection')?.secret;
  const action = data['action'] as SlackResponseAction | undefined;
  // Record shape/presence only: never payload text, credential values or the full event.
  console.info('slack response operation received', {
    action: typeof action === 'string' ? action : 'missing',
    payload_keys: Object.keys(event.payload),
    operation_keys: Object.keys(data),
    input_keys: Object.keys(event.input_data),
    has_slack_connection: !!slackToken,
    has_service_identity: !!event.context.secrets.service_account_token,
  });
  if (!slackToken || !action) {
    return { error: { message: 'Required Slack connection or response action is unavailable.', type: 0 }, status: 3, port_outputs: EMPTY_PORT_OUTPUTS };
  }
  try {
  const install = (data['snap_in_id'] as string | undefined) || event.context.snap_in_id;
  // Operations use the scoped caller identity; event automations keep their service identity.
  const token = event.context.secrets.access_token || event.context.secrets.service_account_token;
  const devrev = new DevRevClient(event.execution_metadata.devrev_endpoint, token);
  const installed = await devrev.post<{ snap_in: { inputs_values: Record<string, string> } }>('snap-ins.get', { id: install });
  const globals = installed.snap_in.inputs_values;
  const slack = new WebClient(slackToken, { retryConfig: { retries: 0 } });
  const input: ManageSlackResponseInput = {
    install,
    workflow_mode: globals['invoke_mode'],
    agent_id: globals['agent_id'],
    expected_bot_user_id: globals['slack_bot_user_id'],
    acting_session: data['acting_session'] as string | undefined,
    agent_session_id: data['agent_session_id'] as string | undefined,
    channel: data['channel'] as string | undefined,
    decision: data['decision'] as string | undefined,
    error_code: data['error_code'] as string | undefined,
    job_id: data['job_id'] as string | undefined,
    message_ts: data['message_ts'] as string | undefined,
    rationale: data['rationale'] as string | undefined,
    receipt_id: data['receipt_id'] as string | undefined,
    // No default here: post_root needs an explicit key, and manageSlackResponse defaults the others.
    response_event: data['response_event'] as string | undefined,
    session_key: data['session_key'] as string | undefined,
    skill_call_id: data['skill_call_id'] as string | undefined,
    text: data['text'] as string | undefined,
    thread_ts: data['thread_ts'] as string | undefined,
    workflow_run_id: data['workflow_run_id'] as string | undefined,
  };
    const result = await manageSlackResponse(action, input, devrev, { slack }, globals['act_as_user_id']);
    // Reply-tool business outcomes remain structured facts. Intake cannot complete successfully
    // when preparation/finalization failed or delivery is unknown; its error branch records that.
    if ((action === 'prepare' || action === 'finalize' || action === 'fail') && result.outcome !== 'ok') {
      return { error: { message: result.summary, type: 0 }, summary: result.summary, status: 3, port_outputs: EMPTY_PORT_OUTPUTS };
    }
    return { output: { values: [{ ...result, body: JSON.stringify(result) }] }, summary: result.summary, status: 1, port_outputs: EMPTY_PORT_OUTPUTS };
  } catch (error) {
    const code = axios.isAxiosError(error) ? `operation_http_${error.response?.status || 'unconfirmed'}` : error instanceof Error && /^[a-z_]{1,80}$/.test(error.message) ? error.message : 'response_outcome_unconfirmed';
    return { error: { message: `${code}. Read the tracked response before considering a retry.`, type: 0 }, status: 3, port_outputs: EMPTY_PORT_OUTPUTS };
  }
};
const run = async (events: FunctionEvent[]): Promise<undefined | OperationOutput> => {
  if (events.length === 1 && events[0].execution_metadata.event_type !== 'timer.tick') {
    console.info('slack handler input shape', {
      event_type: events[0].execution_metadata.event_type,
      payload_keys: Object.keys(events[0].payload),
      operation_keys: Object.keys(operationData(events[0])),
      input_keys: Object.keys(events[0].input_data),
    });
  }
  if (events.length === 1 && operationData(events[0])['node'] === 'manage_slack_response') return OperationOutput.fromJSON(await handleManageSlackResponse(events[0]));
  for (const event of events) {
    if (event.execution_metadata.event_type === 'timer.tick') await runSlackPoller([event]);
    else await handleEvent(event);
  }
  return undefined;
};
export default run;
