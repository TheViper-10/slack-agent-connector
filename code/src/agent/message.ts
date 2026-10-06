import type { WebClient } from '@slack/web-api';

import type { DevRevClient } from '../clients/devrev';
import { THREAD_DM_METADATA_EVENT } from './constants';

export interface SlackMessage {
  attachments?: SlackAttachment[];
  channel: string;
  prompt: string;
  promptTs: string;
  threadTs: string;
}

export interface SlackAttachment {
  mimetype?: string;
  name: string;
  size?: number;
  url: string;
}

export interface ThreadMessage {
  bot_id?: string;
  metadata?: unknown;
  subtype?: string;
  text?: string;
  ts?: string;
  user?: string;
}

export interface ThreadDm {
  agentSvcAccId: string;
  dmObject: string;
}

interface SlackMessagePayload {
  event?: {
    bot_id?: string;
    channel?: string;
    channel_type?: string;
    edited?: { ts?: string; user?: string };
    files?: Array<{
      id?: string;
      mimetype?: string;
      name?: string;
      size?: number;
      url_private?: string;
      url_private_download?: string;
    }>;
    subtype?: string;
    text?: string;
    thread_ts?: string;
    ts?: string;
    type?: string;
    user?: string;
  };
}

const parseAttachments = (event: NonNullable<SlackMessagePayload['event']>): SlackAttachment[] =>
  (event.files ?? []).flatMap((file) => {
    const url = file.url_private_download ?? file.url_private;
    if (!url) return [];
    return [
      {
        ...(file.mimetype ? { mimetype: file.mimetype } : {}),
        name: file.name ?? (file.id ? `slack-${file.id}` : 'slack-attachment'),
        ...(file.size !== undefined ? { size: file.size } : {}),
        url,
      },
    ];
  });

export const parseDirectMessage = (payload: unknown, botUserId?: string): SlackMessage | undefined => {
  const event = (payload as SlackMessagePayload | undefined)?.event;
  if (event?.type !== 'message' || event.channel_type !== 'im' || event.bot_id || event.edited) return;
  if (event.subtype && event.subtype !== 'file_share') return;
  if (!event.channel || !event.ts || !event.user || event.user === botUserId) return;
  const prompt = event.text?.trim();
  if (!prompt) return;
  return {
    attachments: parseAttachments(event),
    channel: event.channel,
    prompt,
    promptTs: event.ts,
    threadTs: event.thread_ts ?? event.ts,
  };
};

export const parseChannelMention = (payload: unknown, botUserId?: string): SlackMessage | undefined => {
  const event = (payload as SlackMessagePayload | undefined)?.event;
  if (event?.type !== 'app_mention' || event.subtype || event.bot_id || event.edited || !botUserId) return;
  if (!event.channel || !event.ts || !event.user || event.user === botUserId) return;
  const mention = `<@${botUserId}>`;
  if (!event.text?.includes(mention)) return;
  const prompt = event.text.replaceAll(mention, '').trim();
  if (!prompt) return;
  return {
    attachments: parseAttachments(event),
    channel: event.channel,
    prompt,
    promptTs: event.ts,
    threadTs: event.thread_ts ?? event.ts,
  };
};

export interface SlackAuthoredMessage {
  app_id?: string;
  metadata?: unknown;
  user?: string;
}

export interface OwnSlackBot {
  appId?: string;
  botUserId?: string;
}

/** True for messages this install's Slack bot posted. */
export const isOwnBotMessage = (message: SlackAuthoredMessage, own: OwnSlackBot): boolean =>
  (!!own.botUserId && message.user === own.botUserId) || (!!own.appId && message.app_id === own.appId);

/**
 * Finds the DM recorded on the latest reply this bot relayed into the thread. Other bots connected by other installs
 * record their own DMs in the same thread, so only this bot's messages are trusted.
 */
export const findThreadDm = (messages: SlackAuthoredMessage[], own: OwnSlackBot): ThreadDm | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (!isOwnBotMessage(messages[index]!, own)) continue;
    const metadata = messages[index]?.metadata as
      | { event_payload?: { agent_svcacc?: string; dm_object?: string }; event_type?: string }
      | undefined;
    if (
      metadata?.event_type === THREAD_DM_METADATA_EVENT &&
      metadata.event_payload?.dm_object &&
      metadata.event_payload?.agent_svcacc
    ) {
      return {
        agentSvcAccId: metadata.event_payload.agent_svcacc,
        dmObject: metadata.event_payload.dm_object,
      };
    }
  }
  return;
};

const DEVREV_USER_MENTION = /<(don:identity:[^>]+:devu\/[^>]+)>/g;

export const resolveDevRevUserMentionsForSlack = async (
  text: string,
  devrev: DevRevClient,
  slack: WebClient
): Promise<string> => {
  const devUserIds = Array.from(new Set(Array.from(text.matchAll(DEVREV_USER_MENTION), (match) => match[1])));
  const slackMentions = new Map(
    await Promise.all(
      devUserIds.map(async (devUserId) => {
        try {
          const response = await devrev.post<{
            dev_user?: { display_name?: string; email?: string; full_name?: string };
          }>('dev-users.get', { id: devUserId });
          const devUser = response.dev_user;
          if (devUser?.email) {
            const slackUser = await slack.users.lookupByEmail({ email: devUser.email });
            if (slackUser.user?.id) return [devUserId, `<@${slackUser.user.id}>`] as const;
          }
          const fallbackName = devUser?.full_name || devUser?.display_name;
          if (fallbackName) return [devUserId, `@${fallbackName}`] as const;
        } catch {
          // Preserve a readable fallback when either user lookup is unavailable.
        }
        const displayId = devUserId.match(/:devu\/([^:>]+)/)?.[1];
        return [devUserId, displayId ? `DEVU-${displayId}` : 'DevRev user'] as const;
      })
    )
  );
  return text.replace(
    DEVREV_USER_MENTION,
    (_mention, devUserId: string) => slackMentions.get(devUserId) ?? 'DevRev user'
  );
};

const donToDisplayId = (_match: string, type: string, number: string): string => {
  const prefixes: Record<string, string> = {
    ai_agent: 'AI-AGENT',
    conversation: 'CONV',
    dev_user: 'DEVU',
    issue: 'ISS',
    rev_user: 'REVU',
    ticket: 'TKT',
  };
  return `${prefixes[type] ?? type.toUpperCase()}-${number}`;
};

export const prepareMarkdownForSlack = (text: string): string => {
  let markdown = text.replace(/\[<don:[^\]]*\]/g, '');
  markdown = markdown.replace(/<don:<don:core:[^>]+:(\w+)\/(\d+)>/g, donToDisplayId);
  markdown = markdown.replace(/<don:core:[^>]+:(\w+)\/(\d+)>/g, donToDisplayId);
  markdown = markdown.replace(/<don:[^>]*>?/g, '').replace(/don:\S+/g, '');
  return markdown.replace(/\n{3,}/g, '\n\n').trim();
};

export const splitSlackSections = (text: string, limit: number): string[] => {
  const sections: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= limit) {
      sections.push(rest);
      break;
    }
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = limit;
    sections.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  return sections;
};

export const buildDmLink = (appUrl: string, devOrgSlug: string, dmObject: string): string =>
  `${appUrl}/${devOrgSlug}/computer/dm?chatId=${encodeURIComponent(dmObject)}`;
