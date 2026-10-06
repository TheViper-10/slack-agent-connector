import { WebClient } from '@slack/web-api';

import { DevRevClient } from '../../clients/devrev';
import { claimSlackApp, releaseSlackApp, SlackAppClaimedError } from '../../poller/claim';
import { type FunctionEvent, getKeyring, type HookResponse } from '../../types';
import { installDmSchema, installPollerSchema } from './schema';

interface SlackIdentity {
  appId: string;
  botUserId: string;
  teamId: string;
}

const resolveSlackIdentity = async (slack: WebClient): Promise<SlackIdentity> => {
  const auth = await slack.auth.test();
  if (!auth.bot_id || !auth.user_id || !auth.team_id)
    throw new Error('Slack auth.test did not return bot, user, and team IDs');
  const bot = await slack.bots.info({ bot: auth.bot_id });
  if (!bot.bot?.app_id) throw new Error('Slack bots.info did not return an app ID');
  return { appId: bot.bot.app_id, botUserId: auth.user_id, teamId: auth.team_id };
};

const orgOf = (don: string): string | undefined => /devo\/[A-Za-z0-9]+/.exec(don)?.[0];

/** Agent and act-as user must be DONs of the org this snap-in is installed in; the org comes from the event. */
const validateOrgMembership = (event: FunctionEvent): void => {
  const agentId = event.input_data.global_values?.['agent_id'];
  const actAsUserId = event.input_data.global_values?.['act_as_user_id'];

  if (!agentId) throw new Error('agent_id is required');
  if (!actAsUserId) throw new Error('act_as_user_id is required');

  const installedOrg = orgOf(event.context.dev_oid);
  if (!installedOrg) throw new Error(`could not derive the installed org from ${event.context.dev_oid}`);
  if (orgOf(agentId) !== installedOrg) {
    throw new Error(`agent_id must belong to org ${installedOrg}, got: ${agentId}`);
  }
  if (orgOf(actAsUserId) !== installedOrg) {
    throw new Error(`act_as_user_id must belong to org ${installedOrg}, got: ${actAsUserId}`);
  }
};

/**
 * Best effort at activation: on a first install the service account cannot write objects of leaf types created
 * moments earlier, so only a real conflict fails activation. The poller re-checks the claim on every tick.
 */
const claimSlackAppOnActivate = async (devrev: DevRevClient, appId: string, installId: string): Promise<void> => {
  try {
    await claimSlackApp(devrev, appId, installId);
  } catch (error) {
    if (error instanceof SlackAppClaimedError) throw error;
    console.warn('Slack app claim deferred to the first poll tick:', error instanceof Error ? error.message : error);
  }
};

/** Best effort: a failed release must not block deactivation; the successor can still take over a stale claim. */
const releaseSlackAppOnDeactivate = async (event: FunctionEvent): Promise<void> => {
  const appId = event.input_data.global_values?.['slack_app_id'];
  if (!appId) return;
  try {
    const devrev = new DevRevClient(
      event.execution_metadata.devrev_endpoint,
      event.context.secrets.service_account_token
    );
    await releaseSlackApp(devrev, appId, event.context.snap_in_id);
  } catch (error) {
    console.warn('Slack app claim release skipped:', error instanceof Error ? error.message : error);
  }
};

export const handleEvent = async (event: FunctionEvent): Promise<HookResponse | undefined> => {
  const type = event.execution_metadata.event_type;
  // Slack is polled by a timer; there is no inbound route to register or deregister.
  if (type === 'hook:snap_in_deactivate') {
    await releaseSlackAppOnDeactivate(event);
    return;
  }

  validateOrgMembership(event);

  const slackToken = getKeyring(event, 'slack_connection')?.secret;
  if (!slackToken) throw new Error('Slack connection is required');
  const slackIdentity = await resolveSlackIdentity(new WebClient(slackToken));

  if (type === 'hook:snap_in_validate') return;
  if (type !== 'hook:snap_in_activate' && type !== 'hook:snap_in_update') return;

  const devrev = new DevRevClient(
    event.execution_metadata.devrev_endpoint,
    event.context.secrets.service_account_token
  );
  await installDmSchema(devrev);
  await installPollerSchema(devrev);
  await claimSlackAppOnActivate(devrev, slackIdentity.appId, event.context.snap_in_id);

  const org = await devrev.post<{ dev_org?: { dev_slug?: string } }>('dev-orgs.get', {});
  const devOrgSlug = org.dev_org?.dev_slug;
  if (!devOrgSlug) throw new Error('DevRev organization slug could not be resolved');

  return {
    id: event.context.snap_in_id,
    inputs_values: {
      dev_org_slug: devOrgSlug,
      slack_app_id: slackIdentity.appId,
      slack_bot_user_id: slackIdentity.botUserId,
      slack_team_id: slackIdentity.teamId,
    },
  };
};

const run = async (events: FunctionEvent[]): Promise<HookResponse | undefined> => {
  const event = events[0];
  return event ? handleEvent(event) : undefined;
};

export default run;
