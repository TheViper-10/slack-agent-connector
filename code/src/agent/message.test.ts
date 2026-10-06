import { findThreadDm, parseChannelMention, parseDirectMessage } from './message';

const BOT_USER_ID = 'UBOT';

const dmPayload = (overrides: Record<string, unknown> = {}) => ({
  event: {
    channel: 'D123',
    channel_type: 'im',
    text: 'run the tests',
    ts: '1700000000.000100',
    type: 'message',
    user: 'U123',
    ...overrides,
  },
});

const mentionPayload = (overrides: Record<string, unknown> = {}) => ({
  event: {
    channel: 'C123',
    text: `<@${BOT_USER_ID}> run the tests`,
    ts: '1700000001.000100',
    type: 'app_mention',
    user: 'U123',
    ...overrides,
  },
});

describe('parseDirectMessage', () => {
  it('parses a new bot DM', () => {
    const result = parseDirectMessage(dmPayload(), BOT_USER_ID);
    expect(result).toMatchObject({
      channel: 'D123',
      prompt: 'run the tests',
      promptTs: '1700000000.000100',
      threadTs: '1700000000.000100',
    });
  });

  it('uses thread_ts when present (follow-up)', () => {
    const result = parseDirectMessage(dmPayload({ thread_ts: '1700000000.000000' }), BOT_USER_ID);
    expect(result?.threadTs).toBe('1700000000.000000');
    expect(result?.promptTs).toBe('1700000000.000100');
  });

  it('ignores bot messages (has bot_id)', () => {
    expect(parseDirectMessage(dmPayload({ bot_id: 'B1' }), BOT_USER_ID)).toBeUndefined();
  });

  it('ignores edited messages', () => {
    expect(parseDirectMessage(dmPayload({ edited: { ts: '1', user: 'U1' } }), BOT_USER_ID)).toBeUndefined();
  });

  it('ignores messages from the bot user itself', () => {
    expect(parseDirectMessage(dmPayload({ user: BOT_USER_ID }), BOT_USER_ID)).toBeUndefined();
  });

  it('ignores messages with no text', () => {
    expect(parseDirectMessage(dmPayload({ text: '' }), BOT_USER_ID)).toBeUndefined();
    expect(parseDirectMessage(dmPayload({ text: '   ' }), BOT_USER_ID)).toBeUndefined();
  });

  it('ignores non-IM channel types', () => {
    expect(parseDirectMessage(dmPayload({ channel_type: 'channel' }), BOT_USER_ID)).toBeUndefined();
  });

  it('ignores non-message event types', () => {
    expect(parseDirectMessage(dmPayload({ type: 'app_mention' }), BOT_USER_ID)).toBeUndefined();
  });

  it('ignores unsupported subtypes', () => {
    expect(parseDirectMessage(dmPayload({ subtype: 'message_deleted' }), BOT_USER_ID)).toBeUndefined();
  });

  it('accepts file_share subtype', () => {
    expect(parseDirectMessage(dmPayload({ subtype: 'file_share' }), BOT_USER_ID)).toBeDefined();
  });

  it('parses file attachments', () => {
    const result = parseDirectMessage(
      dmPayload({
        files: [
          {
            id: 'F1',
            mimetype: 'text/plain',
            name: 'spec.txt',
            size: 100,
            url_private_download: 'https://files.slack.com/files-pri/T1-F1/download/spec.txt',
          },
        ],
      }),
      BOT_USER_ID
    );
    expect(result?.attachments).toHaveLength(1);
    expect(result?.attachments?.[0]).toMatchObject({ mimetype: 'text/plain', name: 'spec.txt' });
  });
});

describe('parseChannelMention', () => {
  it('parses a channel mention', () => {
    const result = parseChannelMention(mentionPayload(), BOT_USER_ID);
    expect(result).toMatchObject({
      channel: 'C123',
      prompt: 'run the tests',
      promptTs: '1700000001.000100',
    });
  });

  it('strips the bot mention from the prompt', () => {
    const result = parseChannelMention(mentionPayload({ text: `<@${BOT_USER_ID}> run the tests` }), BOT_USER_ID);
    expect(result?.prompt).toBe('run the tests');
  });

  it('ignores messages that do not mention the bot', () => {
    expect(parseChannelMention(mentionPayload({ text: 'just a message' }), BOT_USER_ID)).toBeUndefined();
  });

  it('ignores messages with no remaining prompt after stripping mention', () => {
    expect(parseChannelMention(mentionPayload({ text: `<@${BOT_USER_ID}>` }), BOT_USER_ID)).toBeUndefined();
  });

  it('ignores bot messages', () => {
    expect(parseChannelMention(mentionPayload({ bot_id: 'B1' }), BOT_USER_ID)).toBeUndefined();
  });

  it('ignores edited messages', () => {
    expect(parseChannelMention(mentionPayload({ edited: { ts: '1', user: 'U1' } }), BOT_USER_ID)).toBeUndefined();
  });

  it('ignores messages from the bot user itself', () => {
    expect(parseChannelMention(mentionPayload({ user: BOT_USER_ID }), BOT_USER_ID)).toBeUndefined();
  });

  it('returns undefined when botUserId is missing', () => {
    expect(parseChannelMention(mentionPayload(), undefined)).toBeUndefined();
  });

  it('uses thread_ts for thread replies', () => {
    const result = parseChannelMention(mentionPayload({ thread_ts: '1700000001.000000' }), BOT_USER_ID);
    expect(result?.threadTs).toBe('1700000001.000000');
  });
});

describe('findThreadDm', () => {
  const own = { appId: 'AOWN', botUserId: 'UBOT' };
  const dmMetadata = (dm: string, svcacc: string) => ({
    event_payload: { agent_svcacc: svcacc, dm_object: dm },
    event_type: 'slack_agent_chat',
  });

  it('finds the DM object from a bot reply with slack_agent_chat metadata', () => {
    const messages = [{ metadata: undefined }, { metadata: dmMetadata('dm-1', 'svcacc-1'), user: 'UBOT' }];
    expect(findThreadDm(messages, own)).toEqual({ agentSvcAccId: 'svcacc-1', dmObject: 'dm-1' });
  });

  it('returns undefined when no matching metadata is found', () => {
    expect(
      findThreadDm(
        [{ metadata: { event_payload: { dm_object: 'dm-1' }, event_type: 'computer_chat' }, user: 'UBOT' }],
        own
      )
    ).toBeUndefined();
    expect(findThreadDm([], own)).toBeUndefined();
  });

  it('returns undefined when metadata has no agent_svcacc', () => {
    expect(
      findThreadDm(
        [{ metadata: { event_payload: { dm_object: 'dm-1' }, event_type: 'slack_agent_chat' }, user: 'UBOT' }],
        own
      )
    ).toBeUndefined();
  });

  it('returns the last matching metadata in the thread', () => {
    const messages = [
      { metadata: dmMetadata('dm-old', 'svcacc-old'), user: 'UBOT' },
      { metadata: dmMetadata('dm-new', 'svcacc-new'), user: 'UBOT' },
    ];
    expect(findThreadDm(messages, own)).toEqual({ agentSvcAccId: 'svcacc-new', dmObject: 'dm-new' });
  });

  it('ignores DMs recorded by another bot in a shared thread and matches its own app ID', () => {
    const messages = [
      { app_id: 'AOWN', metadata: dmMetadata('dm-own', 'svcacc-own') },
      { app_id: 'AOTHER', metadata: dmMetadata('dm-other', 'svcacc-other'), user: 'UOTHER' },
    ];
    expect(findThreadDm(messages, own)).toEqual({ agentSvcAccId: 'svcacc-own', dmObject: 'dm-own' });
    expect(findThreadDm(messages.slice(1), own)).toBeUndefined();
  });
});
