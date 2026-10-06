import type { WebClient } from '@slack/web-api';

const updateWorkingStatus = async (
  slack: WebClient,
  channel: string,
  threadTs: string,
  status: string
): Promise<void> => {
  try {
    await slack.assistant.threads.setStatus({ channel_id: channel, status, thread_ts: threadTs });
  } catch {
    // Status is an optional UX enhancement and must not block agent invocation or delivery.
  }
};

export const setSlackWorkingStatus = async (slack: WebClient, channel: string, threadTs: string): Promise<void> =>
  updateWorkingStatus(slack, channel, threadTs, 'is working...');

export const clearSlackWorkingStatus = async (slack: WebClient, channel: string, threadTs: string): Promise<void> =>
  updateWorkingStatus(slack, channel, threadTs, '');
