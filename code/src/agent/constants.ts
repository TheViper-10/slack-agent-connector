export const APP_NAME = 'slack_agent_connector';
export const APP_URL_FROM_API = (endpoint: string): string => endpoint.replace('api', 'app').replace(/\/$/, '');
export const CF_AGENT_SVCACC = 'app_slack_agent_connector__agent_svcacc';
export const CF_LAST_IMPORTED_TS = 'app_slack_agent_connector__last_imported_ts';
export const CF_PROMPT_TS = 'app_slack_agent_connector__prompt_ts';
export const CF_SLACK_CHANNEL = 'app_slack_agent_connector__slack_channel';
export const CF_SLACK_THREAD_TS = 'app_slack_agent_connector__slack_thread_ts';
export const DEFAULT_DISPLAY_NAME = 'DevRev agent';
export const DISCUSSIONS_LABEL = 'display:discussions';
export const MAX_PROMPT_LENGTH = 16_384;
export const MAX_SLACK_ATTACHMENTS = 50;
export const SLACK_MARKDOWN_TEXT_LIMIT = 12_000;
export const THINKING_REACTION = 'hourglass_flowing_sand';
export const THREAD_DM_METADATA_EVENT = 'slack_agent_chat';

export const displayNameOf = (globalValues: Record<string, string> | undefined): string =>
  globalValues?.['display_name']?.trim() || DEFAULT_DISPLAY_NAME;

export const messagesFor = (displayName: string) =>
  ({
    INVOCATION_FAILED: `Something went wrong invoking the ${displayName}. Please try again.`,
    NO_AGENT: `${displayName} not found or misconfigured. Contact your admin.`,
    TOKEN_FAILED: 'Could not authenticate as the configured DevRev user. Contact your admin.',
  }) as const;
