import type { WebClient } from '@slack/web-api';

import type { DevRevClient } from '../clients/devrev';
import type { FunctionEvent } from '../types';
import {
  CF_AGENT_SVCACC,
  displayNameOf,
  CF_PROMPT_TS,
  CF_SLACK_CHANNEL,
  CF_SLACK_THREAD_TS,
  SLACK_MARKDOWN_TEXT_LIMIT,
  THINKING_REACTION,
  THREAD_DM_METADATA_EVENT,
} from './constants';
import { prepareMarkdownForSlack, resolveDevRevUserMentionsForSlack, splitSlackSections } from './message';
import { appendDevRevArtifactsForSlack, type ArtifactSummary } from './response_attachments';
import { clearSlackWorkingStatus } from './status';

interface AiAssistantMessageFileReference {
  artifact?: ArtifactSummary;
  path: string;
  status: 'created' | 'updated';
}

interface AiAssistantMessageWidget {
  file_references?: AiAssistantMessageFileReference[];
  message?: string;
  state?: string;
  type?: string;
}

export interface TimelineEntry {
  artifacts?: ArtifactSummary[];
  body?: string;
  created_by?: {
    display_name?: string;
    email?: string;
    full_name?: string;
    id?: string;
    thumbnail?: string;
    type?: string;
  };
  created_by_agent?: { id?: string };
  external_ref?: string;
  id?: string;
  object?: string;
  object_type?: string;
  snap_widget_body?: AiAssistantMessageWidget[];
  type?: string;
}

const responseWidget = (entry: TimelineEntry): AiAssistantMessageWidget | undefined =>
  entry.snap_widget_body?.find((widget) => widget.type === 'ai_assistant_message' && widget.state === 'success');

const artifactFromFileReference = (reference: AiAssistantMessageFileReference): ArtifactSummary | undefined => {
  if (!reference.artifact?.id) return undefined;
  const filename = reference.path.split('/').filter(Boolean).at(-1) ?? reference.artifact.file?.name;
  if (!filename) return undefined;
  return {
    ...reference.artifact,
    file: { ...reference.artifact.file, name: filename },
  };
};

const getResponseWidgetFileArtifacts = (widget: AiAssistantMessageWidget | undefined): ArtifactSummary[] => {
  const artifacts = (widget?.file_references ?? [])
    .map(artifactFromFileReference)
    .filter((artifact): artifact is ArtifactSummary => !!artifact);
  return artifacts.filter((artifact, index) => artifacts.findIndex(({ id }) => id === artifact.id) === index);
};

export const isRelayableAgentReply = (entry: TimelineEntry, agentSvcAccId: string): boolean => {
  const authorId = entry.created_by?.id ?? entry.created_by_agent?.id;
  const widget = responseWidget(entry);
  return (
    entry.type === 'timeline_comment' &&
    entry.object_type === 'dm' &&
    (!!widget?.message?.trim() || !!getResponseWidgetFileArtifacts(widget).length || !!entry.body?.trim()) &&
    !entry.external_ref?.startsWith('slack:') &&
    !entry.external_ref?.startsWith('slack-context:') &&
    authorId === agentSvcAccId
  );
};

const isDmCommentRelayCandidate = (entry: TimelineEntry): boolean => {
  const widget = responseWidget(entry);
  return (
    entry.type === 'timeline_comment' &&
    entry.object_type === 'dm' &&
    (!!widget?.message?.trim() ||
      !!getResponseWidgetFileArtifacts(widget).length ||
      !!entry.body?.trim() ||
      !!entry.artifacts?.length) &&
    !entry.external_ref?.startsWith('slack:') &&
    !entry.external_ref?.startsWith('slack-context:')
  );
};

const getSlackAuthor = async (
  entry: TimelineEntry,
  slack: WebClient
): Promise<{ icon_url?: string; username: string } | undefined> => {
  const devUser = entry.created_by;
  if (devUser?.type !== 'dev_user') return undefined;

  if (devUser?.email) {
    try {
      const response = await slack.users.lookupByEmail({ email: devUser.email });
      const profile = response.user?.profile;
      const username = profile?.display_name || profile?.real_name;
      if (username) return { icon_url: profile?.image_72, username };
    } catch {
      // Fall back to the DevRev profile when the Slack user cannot be resolved.
    }
  }

  const username = devUser?.full_name || devUser?.display_name;
  if (!username) return undefined;
  return { icon_url: devUser?.thumbnail, username };
};

export const relayAgentReply = async (event: FunctionEvent, devrev: DevRevClient, slack: WebClient): Promise<void> => {
  const entry = (event.payload['timeline_entry_created'] as { entry?: TimelineEntry } | undefined)?.entry;
  if (!entry?.object || !entry.id || !isDmCommentRelayCandidate(entry)) return;

  const chatResponse = await devrev.post<{ chat?: { custom_fields?: Record<string, string> } }>('chats.get', {
    id: entry.object,
  });
  const fields = chatResponse.chat?.custom_fields;
  const channel = fields?.[CF_SLACK_CHANNEL];
  const threadTs = fields?.[CF_SLACK_THREAD_TS];
  const agentSvcAccId = fields?.[CF_AGENT_SVCACC];
  if (!channel || !threadTs || !agentSvcAccId) return;

  const agentReply = isRelayableAgentReply(entry, agentSvcAccId);
  const slackAuthor = agentReply ? undefined : await getSlackAuthor(entry, slack);
  if (!agentReply && !slackAuthor) return;

  const widget = responseWidget(entry);
  const resolvedBody = await resolveDevRevUserMentionsForSlack(widget?.message ?? entry.body ?? '', devrev, slack);
  const artifacts = agentReply ? getResponseWidgetFileArtifacts(widget) : (entry.artifacts ?? []);
  const text = await appendDevRevArtifactsForSlack(
    prepareMarkdownForSlack(resolvedBody),
    artifacts,
    undefined,
    devrev,
    slack
  );
  const chunks = splitSlackSections(text, SLACK_MARKDOWN_TEXT_LIMIT);
  let responseTs: string | undefined;
  for (const chunk of chunks) {
    const blocks = [{ text: chunk, type: 'markdown' as const }];
    const response = await slack.chat.postMessage({
      blocks,
      channel,
      ...(slackAuthor ?? {}),
      metadata: {
        event_payload: { agent_svcacc: agentSvcAccId, dm_object: entry.object },
        event_type: THREAD_DM_METADATA_EVENT,
      },
      text: chunk,
      thread_ts: threadTs,
    });
    if (!response.ok) return;
    responseTs = response.ts;
  }
  if (!responseTs) return;

  await devrev.post('timeline-entries.update', {
    external_ref: `slack:${channel}:${responseTs}`,
    id: entry.id,
    type: 'timeline_comment',
  });

  const promptTs = fields?.[CF_PROMPT_TS];
  if (agentReply) {
    await Promise.allSettled([
      clearSlackWorkingStatus(slack, channel, threadTs),
      ...(promptTs ? [slack.reactions.remove({ channel, name: THINKING_REACTION, timestamp: promptTs })] : []),
    ]);
  }
};

interface AsyncAgentResponse {
  agent_response?: string;
  artifact_ids?: string[];
  client_metadata?: {
    channel_id?: string;
    message_ts?: string;
    thread_ts?: string;
  };
  error?: { error?: string };
  message?: string;
}

export const relayAsyncAgentResponse = async (
  event: FunctionEvent,
  devrev: DevRevClient,
  slack: WebClient
): Promise<void> => {
  const response = event.payload['ai_agent_response'] as AsyncAgentResponse | undefined;
  if (response?.agent_response !== 'message' && response?.agent_response !== 'error') return;

  const channel = response.client_metadata?.channel_id;
  const threadTs = response.client_metadata?.thread_ts;
  const messageTs = response.client_metadata?.message_ts;
  if (!channel || !threadTs) return;

  let text: string;
  if (response.agent_response === 'error') {
    text = `${displayNameOf(event.input_data.global_values)} encountered an error: ${response.error?.error ?? 'Something went wrong. Please try again.'}`;
    await slack.chat.postMessage({ channel, text, thread_ts: threadTs });
  } else {
    const resolvedMessage = await resolveDevRevUserMentionsForSlack(response.message ?? '', devrev, slack);
    text = prepareMarkdownForSlack(resolvedMessage);
    text = await appendDevRevArtifactsForSlack(text, undefined, response.artifact_ids, devrev, slack);
    for (const chunk of splitSlackSections(text, SLACK_MARKDOWN_TEXT_LIMIT)) {
      await slack.chat.postMessage({
        blocks: [{ text: chunk, type: 'markdown' }],
        channel,
        text: chunk,
        thread_ts: threadTs,
      });
    }
  }
  await clearSlackWorkingStatus(slack, channel, threadTs);
  if (messageTs) {
    await slack.reactions.remove({ channel, name: THINKING_REACTION, timestamp: messageTs });
  }
};
