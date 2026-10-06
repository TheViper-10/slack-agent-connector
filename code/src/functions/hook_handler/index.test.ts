import { WebClient } from '@slack/web-api';

import type { FunctionEvent } from '../../types';
import { handleEvent } from './index';

jest.mock('@slack/web-api');
jest.mock('../../clients/devrev');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const MockedDevRevClientModule = require('../../clients/devrev') as {
  DevRevClient: { prototype: { post: jest.Mock } };
};

const QA_ORG = 'devo/1LUnsHY977';
const AGENT_ID = `don:core:dvrv-us-1:${QA_ORG}:ai_agent/2`;
const QA_USER_ID = `don:identity:dvrv-us-1:${QA_ORG}:devu/3`;

const makeEvent = (overrides: Partial<FunctionEvent> = {}): FunctionEvent => ({
  context: {
    dev_oid: 'don:identity:dvrv-us-1:devo/1LUnsHY977',
    secrets: { service_account_token: 'svc-token' },
    snap_in_id: 'don:integration:dvrv-us-1:devo/1:snap_in/1',
  },
  execution_metadata: {
    devrev_endpoint: 'https://api.dev.devrev-eng.ai',
    event_type: 'hook:snap_in_activate',
  },
  input_data: {
    event_sources: { 'slack-poll-timer': 'event-source-1' },
    global_values: {
      agent_id: AGENT_ID,
      act_as_user_id: QA_USER_ID,
    },
    resources: {
      keyrings: {
        slack_connection: { secret: 'slack-token' },
      },
    },
  },
  payload: {},
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();

  // Mock Slack WebClient
  const MockWebClient = WebClient as jest.MockedClass<typeof WebClient>;
  Object.defineProperty(MockWebClient.prototype, 'auth', {
    configurable: true,
    value: { test: jest.fn().mockResolvedValue({ bot_id: 'B1', team_id: 'T1', user_id: 'UBOT' }) },
    writable: true,
  });
  Object.defineProperty(MockWebClient.prototype, 'bots', {
    configurable: true,
    value: { info: jest.fn().mockResolvedValue({ bot: { app_id: 'A1' } }) },
    writable: true,
  });

  // Mock DevRevClient instance methods
  MockedDevRevClientModule.DevRevClient.prototype.post = jest.fn(async (path: string) => {
    if (path === 'schemas.custom.set') return {};
    if (path === 'dev-orgs.get') return { dev_org: { dev_slug: 'my-org' } };
    if (path === 'custom-objects.create') return {};
    throw new Error(`Unexpected DevRevClient.post ${path}`);
  });
});

describe('hook_handler', () => {
  const conflict = () => Object.assign(new Error('conflict'), { isAxiosError: true, response: { status: 409 } });

  it('claims the Slack app for this install on activate', async () => {
    await handleEvent(makeEvent());

    const post = MockedDevRevClientModule.DevRevClient.prototype.post;
    expect(post).toHaveBeenCalledWith(
      'custom-objects.create',
      expect.objectContaining({ unique_key: 'slack_agent_connector:slack_app:A1' })
    );
  });

  it('rejects activation when another install already claimed the Slack app', async () => {
    MockedDevRevClientModule.DevRevClient.prototype.post = jest.fn(async (path: string) => {
      if (path === 'schemas.custom.set') return {};
      if (path === 'custom-objects.create') throw conflict();
      if (path === 'custom-objects.get') {
        return { custom_object: { custom_fields: { app_slack_agent_connector__status: 'other-install' } } };
      }
      throw new Error(`Unexpected DevRevClient.post ${path}`);
    });

    await expect(handleEvent(makeEvent())).rejects.toThrow('already connected by another install');
  });

  it('defers the Slack app claim instead of failing activation when the first write is forbidden', async () => {
    MockedDevRevClientModule.DevRevClient.prototype.post = jest.fn(async (path: string) => {
      if (path === 'schemas.custom.set') return {};
      if (path === 'dev-orgs.get') return { dev_org: { dev_slug: 'my-org' } };
      if (path === 'custom-objects.create') {
        throw Object.assign(new Error('forbidden'), { isAxiosError: true, response: { status: 403 } });
      }
      throw new Error(`Unexpected DevRevClient.post ${path}`);
    });

    await expect(handleEvent(makeEvent())).resolves.toBeDefined();
  });

  it('allows re-activation by the install that owns the Slack app', async () => {
    const installId = makeEvent().context.snap_in_id;
    MockedDevRevClientModule.DevRevClient.prototype.post = jest.fn(async (path: string) => {
      if (path === 'schemas.custom.set') return {};
      if (path === 'dev-orgs.get') return { dev_org: { dev_slug: 'my-org' } };
      if (path === 'custom-objects.create') throw conflict();
      if (path === 'custom-objects.get') {
        return { custom_object: { custom_fields: { app_slack_agent_connector__status: installId } } };
      }
      throw new Error(`Unexpected DevRevClient.post ${path}`);
    });

    await expect(handleEvent(makeEvent())).resolves.toBeDefined();
  });

  it('installs the DM, poll-state, and receipt schemas on activate and reads no webhook source', async () => {
    await handleEvent(makeEvent());

    const post = MockedDevRevClientModule.DevRevClient.prototype.post;
    const schemaCalls = post.mock.calls.filter(([p]: [string]) => p === 'schemas.custom.set');
    const leafTypes = schemaCalls.map(
      ([, body]: [string, { leaf_type: string; type: string }]) => `${body.type}:${body.leaf_type}`
    );
    expect(leafTypes).toEqual([
      'app_fragment:dm',
      'tenant_fragment:slack_connector_state',
      'app_fragment:slack_connector_state',
      'tenant_fragment:slack_connector_receipt',
      'app_fragment:slack_connector_receipt',
    ]);
    expect(post.mock.calls.map(([p]: [string]) => p)).not.toContain('event-sources.get');
  });

  it('installs the DM schema with five fields on activate', async () => {
    await handleEvent(makeEvent());

    expect(MockedDevRevClientModule.DevRevClient.prototype.post).toHaveBeenCalledWith(
      'schemas.custom.set',
      expect.objectContaining({
        fields: expect.arrayContaining([
          expect.objectContaining({ name: 'last_imported_ts' }),
          expect.objectContaining({ name: 'slack_channel' }),
          expect.objectContaining({ name: 'agent_svcacc' }),
          expect.objectContaining({ name: 'prompt_ts' }),
          expect.objectContaining({ name: 'slack_thread_ts' }),
        ]),
      })
    );
    const schemaCall = MockedDevRevClientModule.DevRevClient.prototype.post.mock.calls.find(
      ([p, body]: [string, { leaf_type?: string }]) => p === 'schemas.custom.set' && body.leaf_type === 'dm'
    );
    expect(schemaCall?.[1]?.fields).toHaveLength(5);
  });

  it('returns saved input values after activation', async () => {
    const result = await handleEvent(makeEvent());

    expect(result?.inputs_values).toMatchObject({
      dev_org_slug: 'my-org',
      slack_app_id: 'A1',
      slack_bot_user_id: 'UBOT',
      slack_team_id: 'T1',
    });
  });

  it('rejects an agent ID that does not belong to the installed org', async () => {
    const wrongEvent = makeEvent({
      input_data: {
        event_sources: { 'slack-poll-timer': 'event-source-1' },
        global_values: {
          agent_id: 'don:core:dvrv-us-1:devo/WRONG:ai_agent/2',
          act_as_user_id: QA_USER_ID,
        },
        resources: {
          keyrings: {
            slack_connection: { secret: 'slack-token' },
          },
        },
      },
    });

    await expect(handleEvent(wrongEvent)).rejects.toThrow(QA_ORG);
  });

  it('rejects an act_as_user_id that does not belong to the installed org', async () => {
    const wrongEvent = makeEvent({
      input_data: {
        event_sources: { 'slack-poll-timer': 'event-source-1' },
        global_values: {
          agent_id: AGENT_ID,
          act_as_user_id: 'don:identity:dvrv-us-1:devo/WRONG:devu/3',
        },
        resources: {
          keyrings: {
            slack_connection: { secret: 'slack-token' },
          },
        },
      },
    });

    await expect(handleEvent(wrongEvent)).rejects.toThrow(QA_ORG);
  });

  it('throws when agent_id is missing', async () => {
    const noAgentEvent = makeEvent({
      input_data: {
        event_sources: { 'slack-poll-timer': 'event-source-1' },
        global_values: { act_as_user_id: QA_USER_ID },
        resources: {
          keyrings: {
            slack_connection: { secret: 'slack-token' },
          },
        },
      },
    });

    await expect(handleEvent(noAgentEvent)).rejects.toThrow('agent_id is required');
  });

  const makeDeactivateEvent = () =>
    makeEvent({
      execution_metadata: {
        devrev_endpoint: 'https://api.dev.devrev-eng.ai',
        event_type: 'hook:snap_in_deactivate',
      },
      input_data: {
        event_sources: {},
        global_values: { agent_id: AGENT_ID, act_as_user_id: QA_USER_ID, slack_app_id: 'A1' },
        resources: { keyrings: {} },
      },
    });

  it('releases the Slack app claim this install owns on deactivate', async () => {
    const installId = makeEvent().context.snap_in_id;
    const post = jest.fn(async (path: string) => {
      if (path === 'custom-objects.get') {
        return { custom_object: { custom_fields: { app_slack_agent_connector__status: installId }, id: 'claim-1' } };
      }
      if (path === 'custom-objects.delete') return {};
      throw new Error(`Unexpected DevRevClient.post ${path}`);
    });
    MockedDevRevClientModule.DevRevClient.prototype.post = post;

    await expect(handleEvent(makeDeactivateEvent())).resolves.toBeUndefined();
    expect(post).toHaveBeenCalledWith('custom-objects.delete', { id: 'claim-1' });
  });

  it('keeps a claim another install owns and never fails deactivation', async () => {
    const post = jest.fn(async (path: string) => {
      if (path === 'custom-objects.get') {
        return { custom_object: { custom_fields: { app_slack_agent_connector__status: 'other' }, id: 'claim-1' } };
      }
      throw new Error(`Unexpected DevRevClient.post ${path}`);
    });
    MockedDevRevClientModule.DevRevClient.prototype.post = post;

    await expect(handleEvent(makeDeactivateEvent())).resolves.toBeUndefined();
    expect(post).not.toHaveBeenCalledWith('custom-objects.delete', expect.anything());

    MockedDevRevClientModule.DevRevClient.prototype.post = jest.fn(async () => {
      throw Object.assign(new Error('forbidden'), { isAxiosError: true, response: { status: 403 } });
    });
    await expect(handleEvent(makeDeactivateEvent())).resolves.toBeUndefined();
  });

  it('makes no DevRev call on deactivate when no Slack app was resolved', async () => {
    const deactivateEvent = makeEvent({
      execution_metadata: {
        devrev_endpoint: 'https://api.dev.devrev-eng.ai',
        event_type: 'hook:snap_in_deactivate',
      },
      input_data: {
        event_sources: {},
        global_values: {
          agent_id: AGENT_ID,
          act_as_user_id: QA_USER_ID,
        },
        resources: {
          keyrings: {},
        },
      },
    });

    await expect(handleEvent(deactivateEvent)).resolves.toBeUndefined();
    expect(MockedDevRevClientModule.DevRevClient.prototype.post).not.toHaveBeenCalled();
  });

  it('throws when the Slack connection keyring is missing', async () => {
    const noSlackEvent = makeEvent({
      input_data: {
        event_sources: {},
        global_values: {
          agent_id: AGENT_ID,
          act_as_user_id: QA_USER_ID,
        },
        resources: { keyrings: {} },
      },
    });

    await expect(handleEvent(noSlackEvent)).rejects.toThrow('Slack connection is required');
  });

  it('returns undefined without installing schemas on validate', async () => {
    const validateEvent = makeEvent({
      execution_metadata: {
        devrev_endpoint: 'https://api.dev.devrev-eng.ai',
        event_type: 'hook:snap_in_validate',
      },
    });

    const result = await handleEvent(validateEvent);

    expect(result).toBeUndefined();
    expect(MockedDevRevClientModule.DevRevClient.prototype.post).not.toHaveBeenCalled();
  });
});
