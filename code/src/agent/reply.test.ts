import type { WebClient } from '@slack/web-api';

import type { DevRevClient } from '../clients/devrev';
import timelineEntryFixtureJson from '../fixtures/devrev_timeline_entry_created_dm.json';
import type { FunctionEvent } from '../types';
import { isRelayableAgentReply, relayAgentReply, type TimelineEntry } from './reply';

const timelineEntryFixture = timelineEntryFixtureJson as FunctionEvent;
const fixtureEntry = (
  timelineEntryFixture.payload['timeline_entry_created'] as {
    entry: { created_by_agent: { id: string } };
  }
).entry;

describe('isRelayableAgentReply', () => {
  const entry: TimelineEntry = {
    body: 'All tests passed.',
    created_by_agent: { id: 'svcacc-1' },
    external_ref: 'response:prompt-1',
    object_type: 'dm',
    type: 'timeline_comment',
  };

  it('accepts an unrelayed reply from the expected agent service account', () => {
    expect(isRelayableAgentReply(entry, 'svcacc-1')).toBe(true);
  });

  it.each([
    [{ ...entry, object_type: 'ticket' }, 'svcacc-1'],
    [{ ...entry, body: '' }, 'svcacc-1'],
    [{ ...entry, external_ref: 'slack:D1:1.2' }, 'svcacc-1'],
    [entry, 'svcacc-wrong'],
  ])('rejects non-relayable entries', (candidate, expectedAuthor) => {
    expect(isRelayableAgentReply(candidate, expectedAuthor)).toBe(false);
  });

  it('does not relay an entry whose external_ref starts with slack-context:', () => {
    expect(isRelayableAgentReply({ ...entry, external_ref: 'slack-context:C1:1.0' }, 'svcacc-1')).toBe(false);
  });

  it('accepts an artifact-only reply from the expected agent service account', () => {
    expect(
      isRelayableAgentReply(
        {
          ...entry,
          body: '',
          snap_widget_body: [
            {
              file_references: [
                {
                  artifact: { file: { name: 'report.html' }, id: 'artifact-1' },
                  path: '/home/oai/share/report.html',
                  status: 'created',
                },
              ],
              state: 'success',
              type: 'ai_assistant_message',
            },
          ],
        },
        'svcacc-1'
      )
    ).toBe(true);
  });

  it('does not relay artifacts not referenced by the response widget', () => {
    expect(isRelayableAgentReply({ ...entry, artifacts: [{ id: 'artifact-1' }], body: '' }, 'svcacc-1')).toBe(false);
  });
});

describe('relayAgentReply', () => {
  const buildEvent = (entryOverrides: Partial<TimelineEntry> = {}): FunctionEvent => ({
    ...timelineEntryFixture,
    payload: {
      timeline_entry_created: {
        entry: { ...fixtureEntry, ...entryOverrides },
      },
      type: 'timeline_entry_created',
    },
  });

  it('posts the agent reply and marks the entry as relayed', async () => {
    const post = jest.fn(async (path: string) => {
      if (path === 'chats.get') {
        return {
          chat: {
            custom_fields: {
              app_slack_agent_connector__agent_svcacc: fixtureEntry.created_by_agent.id,
              app_slack_agent_connector__prompt_ts: '1.2',
              app_slack_agent_connector__slack_channel: 'D1',
              app_slack_agent_connector__slack_thread_ts: '1.2',
            },
          },
        };
      }
      if (path === 'timeline-entries.update') return {};
      throw new Error(`Unexpected POST ${path}`);
    });
    const devrev = { post } as unknown as DevRevClient;
    const slack = {
      assistant: { threads: { setStatus: jest.fn().mockResolvedValue({}) } },
      chat: { postMessage: jest.fn().mockResolvedValue({ ok: true, ts: '1.3' }) },
      reactions: { remove: jest.fn().mockResolvedValue({}) },
      users: { lookupByEmail: jest.fn().mockRejectedValue(new Error('not found')) },
    } as unknown as WebClient;

    await relayAgentReply(buildEvent(), devrev, slack);

    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'D1',
        thread_ts: '1.2',
      })
    );
    expect(post).toHaveBeenCalledWith(
      'timeline-entries.update',
      expect.objectContaining({ id: (fixtureEntry as { id?: string }).id })
    );
  });

  it('does not relay when DM lacks required custom fields', async () => {
    const post = jest.fn().mockResolvedValue({ chat: { custom_fields: {} } });
    const devrev = { post } as unknown as DevRevClient;
    const slack = { chat: { postMessage: jest.fn() } } as unknown as WebClient;

    await relayAgentReply(buildEvent(), devrev, slack);

    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });

  it('does not relay an entry whose external_ref starts with slack: (already relayed)', async () => {
    const post = jest.fn().mockResolvedValue({
      chat: {
        custom_fields: {
          app_slack_agent_connector__agent_svcacc: fixtureEntry.created_by_agent.id,
          app_slack_agent_connector__slack_channel: 'D1',
          app_slack_agent_connector__slack_thread_ts: '1.2',
        },
      },
    });
    const devrev = { post } as unknown as DevRevClient;
    const slack = { chat: { postMessage: jest.fn() } } as unknown as WebClient;

    await relayAgentReply(buildEvent({ external_ref: 'slack:D1:1.3' }), devrev, slack);

    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });

  it('does not relay a context entry (external_ref starts with slack-context:)', async () => {
    const post = jest.fn().mockResolvedValue({
      chat: {
        custom_fields: {
          app_slack_agent_connector__agent_svcacc: fixtureEntry.created_by_agent.id,
          app_slack_agent_connector__slack_channel: 'D1',
          app_slack_agent_connector__slack_thread_ts: '1.2',
        },
      },
    });
    const devrev = { post } as unknown as DevRevClient;
    const slack = { chat: { postMessage: jest.fn() } } as unknown as WebClient;

    await relayAgentReply(buildEvent({ external_ref: 'slack-context:C1:1.0' }), devrev, slack);

    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });

  it('does not relay a non-agent reply when author cannot be resolved as a Slack user', async () => {
    const post = jest.fn().mockResolvedValue({
      chat: {
        custom_fields: {
          app_slack_agent_connector__agent_svcacc: 'different-svcacc',
          app_slack_agent_connector__slack_channel: 'D1',
          app_slack_agent_connector__slack_thread_ts: '1.2',
        },
      },
    });
    const devrev = { post } as unknown as DevRevClient;
    const slack = { chat: { postMessage: jest.fn() } } as unknown as WebClient;

    // Entry has created_by_agent but it doesn't match agentSvcAccId, and no created_by dev_user.
    await relayAgentReply(buildEvent(), devrev, slack);

    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });

  it('uses slack_agent_chat metadata event type in bot reply metadata', async () => {
    const post = jest.fn(async (path: string) => {
      if (path === 'chats.get') {
        return {
          chat: {
            custom_fields: {
              app_slack_agent_connector__agent_svcacc: fixtureEntry.created_by_agent.id,
              app_slack_agent_connector__prompt_ts: '1.2',
              app_slack_agent_connector__slack_channel: 'D1',
              app_slack_agent_connector__slack_thread_ts: '1.2',
            },
          },
        };
      }
      if (path === 'timeline-entries.update') return {};
      throw new Error(`Unexpected POST ${path}`);
    });
    const devrev = { post } as unknown as DevRevClient;
    const slack = {
      assistant: { threads: { setStatus: jest.fn().mockResolvedValue({}) } },
      chat: { postMessage: jest.fn().mockResolvedValue({ ok: true, ts: '1.3' }) },
      reactions: { remove: jest.fn().mockResolvedValue({}) },
      users: { lookupByEmail: jest.fn().mockRejectedValue(new Error('not found')) },
    } as unknown as WebClient;

    await relayAgentReply(buildEvent(), devrev, slack);

    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ event_type: 'slack_agent_chat' }),
      })
    );
  });

  it('does not relay an empty entry', async () => {
    const post = jest.fn().mockResolvedValue({
      chat: {
        custom_fields: {
          app_slack_agent_connector__agent_svcacc: fixtureEntry.created_by_agent.id,
          app_slack_agent_connector__slack_channel: 'D1',
          app_slack_agent_connector__slack_thread_ts: '1.2',
        },
      },
    });
    const devrev = { post } as unknown as DevRevClient;
    const slack = { chat: { postMessage: jest.fn() } } as unknown as WebClient;

    await relayAgentReply(buildEvent({ artifacts: [], body: '', snap_widget_body: [] }), devrev, slack);

    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });
});
