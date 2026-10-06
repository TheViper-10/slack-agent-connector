import { WebClient } from '@slack/web-api';

import { relayAsyncAgentResponse, relayAgentReply } from '../../agent/reply';
import { DevRevClient } from '../../clients/devrev';
import { type FunctionEvent, getKeyring } from '../../types';

export const handleEvent = async (event: FunctionEvent): Promise<void> => {
  const slackToken = getKeyring(event, 'slack_connection')?.secret;
  if (!slackToken) throw new Error('Slack connection is required');
  const devrev = new DevRevClient(
    event.execution_metadata.devrev_endpoint,
    event.context.secrets.service_account_token
  );
  const slack = new WebClient(slackToken);
  if (event.execution_metadata.event_type === 'ai_agent_response' || event.payload['ai_agent_response']) {
    await relayAsyncAgentResponse(event, devrev, slack);
    return;
  }
  await relayAgentReply(event, devrev, slack);
};

const run = async (events: FunctionEvent[]): Promise<void> => {
  for (const event of events) await handleEvent(event);
};

export default run;
