import axios from 'axios';

import type { DevRevClient } from '../clients/devrev';
import {
  channelKey,
  DevRevStateStore,
  globalKey,
  RECEIPT_LEAF_TYPE,
  receiptKey,
  resolveStateViewer,
  STATE_LEAF_TYPE,
  threadKey,
} from './state';

jest.mock('axios');
const mockedIsAxiosError = jest.mocked(axios.isAxiosError);

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });

const createDevRev = (handler: (path: string, body: Record<string, unknown>) => unknown) => {
  const post = jest.fn(async (path: string, body: Record<string, unknown>) => {
    const result = handler(path, body);
    if (result instanceof Error) throw result;
    return result;
  });
  return { devrev: { post } as unknown as DevRevClient, post };
};

beforeEach(() => {
  mockedIsAxiosError.mockImplementation((e: unknown) => !!(e as { response?: unknown })?.response);
});

describe('DevRevStateStore', () => {
  it('claims a receipt by creating a uniquely keyed custom object', async () => {
    const { devrev, post } = createDevRev(() => ({ custom_object: { id: 'co-1' } }));
    const result = await new DevRevStateStore(devrev, 'inst-1').claimReceipt('D1', '1.1', '1.0', 42);

    expect(result).toEqual({ claimed: true, receipt: { claimedAt: 42, id: 'co-1', status: 'claimed' } });
    expect(post).toHaveBeenCalledWith(
      'custom-objects.create',
      expect.objectContaining({
        custom_fields: expect.objectContaining({
          app_slack_agent_connector__message_ts: '1.1',
          app_slack_agent_connector__status: 'claimed',
        }),
        custom_schema_spec: { apps: ['slack_agent_connector'], tenant_fragment: true },
        leaf_type: RECEIPT_LEAF_TYPE,
        unique_key: 'slack_agent_connector:inst-1:receipt:D1:1.1',
      })
    );
  });

  it('returns the existing receipt when the unique key conflicts', async () => {
    const { devrev } = createDevRev((path) => {
      if (path === 'custom-objects.create') return httpError(409);
      if (path === 'custom-objects.get')
        return {
          custom_object: {
            custom_fields: {
              app_slack_agent_connector__claimed_at: '7',
              app_slack_agent_connector__dm_object: 'dm-9',
              app_slack_agent_connector__status: 'done',
            },
            id: 'co-1',
            leaf_type: RECEIPT_LEAF_TYPE,
            unique_key: 'slack_agent_connector:inst-1:receipt:D1:1.1',
          },
        };
      return {};
    });
    const result = await new DevRevStateStore(devrev, 'inst-1').claimReceipt('D1', '1.1', '1.0', 42);

    expect(result).toEqual({
      claimed: false,
      existing: { claimedAt: 7, dmObject: 'dm-9', id: 'co-1', status: 'done' },
    });
  });

  it('propagates non-conflict errors from receipt creation', async () => {
    const { devrev } = createDevRev(() => httpError(403));
    await expect(new DevRevStateStore(devrev, 'inst-1').claimReceipt('D1', '1.1', '1.0', 1)).rejects.toThrow(
      'HTTP 403'
    );
  });

  it('returns undefined for missing state and parses stored state', async () => {
    const { devrev } = createDevRev((_path, body) => {
      if (body['unique_key'] === 'slack_agent_connector:inst-1:channel:C1')
        return {
          custom_object: {
            custom_fields: {
              app_slack_agent_connector__channel: 'C1',
              app_slack_agent_connector__kind: 'channel',
              app_slack_agent_connector__last_ts: '5.5',
            },
            id: 'co-2',
            unique_key: 'slack_agent_connector:inst-1:channel:C1',
          },
        };
      return httpError(404);
    });
    const store = new DevRevStateStore(devrev, 'inst-1');

    expect(await store.getState('slack_agent_connector:channel:C9')).toBeUndefined();
    expect(await store.getState('slack_agent_connector:inst-1:channel:C1')).toMatchObject({
      channel: 'C1',
      id: 'co-2',
      kind: 'channel',
      lastTs: '5.5',
    });
  });

  it('updates existing state in place and falls back to update when a concurrent create wins', async () => {
    const { devrev, post } = createDevRev((path) => {
      if (path === 'custom-objects.create') return httpError(409);
      if (path === 'custom-objects.get') return { custom_object: { id: 'co-3', unique_key: globalKey('inst-1') } };
      return {};
    });
    const saved = await new DevRevStateStore(devrev, 'inst-1').saveState({
      kind: 'global',
      lastTs: '1.0',
      uniqueKey: globalKey('inst-1'),
    });

    expect(saved.id).toBe('co-3');
    expect(post).toHaveBeenCalledWith(
      'custom-objects.update',
      expect.objectContaining({
        custom_fields: expect.objectContaining({ app_slack_agent_connector__last_ts: '1.0' }),
        id: 'co-3',
      })
    );
  });

  it('namespaces every unique key with the app name because unique keys are org-wide', () => {
    expect(globalKey('inst-1')).toBe('slack_agent_connector:inst-1:global');
    expect(channelKey('inst-1', 'C1')).toBe('slack_agent_connector:inst-1:channel:C1');
    expect(threadKey('inst-1', 'C1', '1.0')).toBe('slack_agent_connector:inst-1:thread:C1:1.0');
    expect(receiptKey('inst-1', 'C1', '1.1')).toBe('slack_agent_connector:inst-1:receipt:C1:1.1');
  });

  it('refuses to adopt an object with the same unique key from a different leaf type', async () => {
    const { devrev, post } = createDevRev((path) => {
      if (path === 'custom-objects.create') return httpError(409);
      if (path === 'custom-objects.get') return { custom_object: { id: 'foreign', leaf_type: 'other_app_state' } };
      return {};
    });
    await expect(
      new DevRevStateStore(devrev, 'inst-1').saveState({
        kind: 'global',
        lastTs: '1.0',
        uniqueKey: globalKey('inst-1'),
      })
    ).rejects.toThrow('belongs to leaf type other_app_state');
    expect(post).not.toHaveBeenCalledWith('custom-objects.update', expect.anything());
  });

  it('shares new and updated state read-only with the configured viewer', async () => {
    const { devrev, post } = createDevRev((path) =>
      path === 'custom-objects.create' ? { custom_object: { id: 'co-1' } } : {}
    );
    const store = new DevRevStateStore(devrev, 'inst-1', {
      member: 'devu-3',
      receiptRole: 'role-r',
      stateRole: 'role-s',
    });

    const saved = await store.saveState({ kind: 'global', lastTs: '1.0', uniqueKey: globalKey('inst-1') });
    await store.saveState({ ...saved, lastTickTs: '2.0' });
    await store.claimReceipt('D1', '1.1', '1.0', 1);

    expect(post).toHaveBeenNthCalledWith(
      1,
      'custom-objects.create',
      expect.objectContaining({ shared_with: [{ member: 'devu-3', role: 'role-s' }] })
    );
    expect(post).toHaveBeenNthCalledWith(
      2,
      'custom-objects.update',
      expect.objectContaining({ shared_with: { upsert: [{ member: 'devu-3', role: 'role-s' }] } })
    );
    expect(post).toHaveBeenNthCalledWith(
      3,
      'custom-objects.create',
      expect.objectContaining({ shared_with: [{ member: 'devu-3', role: 'role-r' }] })
    );
  });

  it('resolves Viewer roles and tolerates role lookup failure', async () => {
    const ok = createDevRev((_path, body) => ({
      roles: [
        { id: 'editor', name: 'Editor' },
        { id: `viewer-${(body['custom_object_target'] as string[])[0]}`, name: 'Viewer' },
      ],
    }));
    await expect(resolveStateViewer(ok.devrev, 'devu-3')).resolves.toEqual({
      member: 'devu-3',
      receiptRole: `viewer-${RECEIPT_LEAF_TYPE}`,
      stateRole: `viewer-${STATE_LEAF_TYPE}`,
    });

    const failing = createDevRev(() => httpError(403));
    await expect(resolveStateViewer(failing.devrev, 'devu-3')).resolves.toBeUndefined();
    await expect(resolveStateViewer(ok.devrev, undefined)).resolves.toBeUndefined();
  });

  it('paginates state listing', async () => {
    const { devrev, post } = createDevRev((_path, body) =>
      body['cursor']
        ? {
            result: [
              {
                custom_fields: { app_slack_agent_connector__kind: 'thread' },
                id: 'b',
                unique_key: threadKey('inst-1', 'D1', '1'),
              },
            ],
          }
        : {
            next_cursor: 'next',
            result: [
              {
                custom_fields: { app_slack_agent_connector__kind: 'global' },
                id: 'a',
                unique_key: globalKey('inst-1'),
              },
            ],
          }
    );
    const records = await new DevRevStateStore(devrev, 'inst-1').listState();

    expect(records.map((r) => r.id)).toEqual(['a', 'b']);
    expect(post).toHaveBeenCalledWith('custom-objects.list', expect.objectContaining({ leaf_type: STATE_LEAF_TYPE }));
  });

  it('ignores state objects outside the app key namespace', async () => {
    const { devrev } = createDevRev(() => ({
      result: [
        { custom_fields: { app_slack_agent_connector__kind: 'channel' }, id: 'legacy', unique_key: 'channel:C1' },
        {
          custom_fields: { app_slack_agent_connector__kind: 'channel' },
          id: 'current',
          unique_key: channelKey('inst-1', 'C1'),
        },
      ],
    }));
    const records = await new DevRevStateStore(devrev, 'inst-1').listState();

    expect(records.map((r) => r.id)).toEqual(['current']);
  });
});
