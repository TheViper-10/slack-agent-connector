import type { DevRevClient } from '../clients/devrev';
import { claimSlackApp, SlackAppClaimedError, STALE_OWNER_MS } from './claim';

const NOW = 1_790_780_000_000;
const OWNER = 'don:integration:dvrv-us-1:devo/1:snap_in/old';
const ME = 'don:integration:dvrv-us-1:devo/1:snap_in/new';
const CLAIM_KEY = 'slack_agent_connector:slack_app:A1';
const OWNER_GLOBAL_KEY = 'slack_agent_connector:old:global';

const httpError = (status: number) =>
  Object.assign(new Error(String(status)), { isAxiosError: true, response: { status } });

const clientWith = (ownerLastTickMs?: number) => {
  const post = jest.fn(async (path: string, body: { unique_key?: string }) => {
    if (path === 'custom-objects.create') throw httpError(409);
    if (path === 'custom-objects.get' && body.unique_key === CLAIM_KEY) {
      return { custom_object: { custom_fields: { app_slack_agent_connector__status: OWNER }, id: 'claim-1' } };
    }
    if (path === 'custom-objects.get' && body.unique_key === OWNER_GLOBAL_KEY) {
      if (ownerLastTickMs === undefined) throw httpError(404);
      const lastTickTs = (ownerLastTickMs / 1000).toFixed(6);
      return { custom_object: { custom_fields: { app_slack_agent_connector__last_tick_ts: lastTickTs } } };
    }
    if (path === 'custom-objects.update') return {};
    throw new Error(`Unexpected post ${path}`);
  });
  return { devrev: { post } as unknown as DevRevClient, post };
};

describe('claimSlackApp', () => {
  it('takes over a claim whose owner stopped ticking', async () => {
    const { devrev, post } = clientWith(NOW - STALE_OWNER_MS - 1000);

    await claimSlackApp(devrev, 'A1', ME, NOW);

    expect(post).toHaveBeenCalledWith(
      'custom-objects.update',
      expect.objectContaining({ custom_fields: { app_slack_agent_connector__status: ME }, id: 'claim-1' })
    );
  });

  it('refuses a claim whose owner ticked recently', async () => {
    const { devrev, post } = clientWith(NOW - 60 * 1000);

    await expect(claimSlackApp(devrev, 'A1', ME, NOW)).rejects.toBeInstanceOf(SlackAppClaimedError);
    expect(post).not.toHaveBeenCalledWith('custom-objects.update', expect.anything());
  });

  it('refuses a claim whose owner never recorded a tick', async () => {
    const { devrev, post } = clientWith(undefined);

    await expect(claimSlackApp(devrev, 'A1', ME, NOW)).rejects.toBeInstanceOf(SlackAppClaimedError);
    expect(post).not.toHaveBeenCalledWith('custom-objects.update', expect.anything());
  });

  it('propagates an unreadable claim instead of taking it over', async () => {
    const post = jest.fn(async (path: string) => {
      if (path === 'custom-objects.create') throw httpError(409);
      throw httpError(403);
    });

    await expect(claimSlackApp({ post } as unknown as DevRevClient, 'A1', ME, NOW)).rejects.toThrow('403');
    expect(post).not.toHaveBeenCalledWith('custom-objects.update', expect.anything());
  });
});
