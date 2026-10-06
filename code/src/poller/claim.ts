import axios from 'axios';

import { APP_NAME } from '../agent/constants';
import type { DevRevClient } from '../clients/devrev';
import { globalKey, STATE_LEAF_TYPE } from './state';

export class SlackAppClaimedError extends Error {}

/** The poller ticks every minute; an owner whose last tick is older than this has stopped polling. */
export const STALE_OWNER_MS = 5 * 60 * 1000;

type ClaimObject = { custom_fields?: Record<string, unknown>; id?: string };

const field = (name: string) => `app_${APP_NAME}__${name}`;
const claimKey = (appId: string) => `${APP_NAME}:slack_app:${appId}`;
const SCHEMA_SPEC = { apps: [APP_NAME], tenant_fragment: true };

const isStatus = (error: unknown, status: number): boolean =>
  axios.isAxiosError(error) && error.response?.status === status;

const getByUniqueKey = async (devrev: DevRevClient, uniqueKey: string): Promise<ClaimObject | undefined> => {
  try {
    const response = await devrev.post<{ custom_object?: ClaimObject }>('custom-objects.get', {
      unique_key: uniqueKey,
    });
    return response.custom_object;
  } catch (error) {
    if (isStatus(error, 404)) return undefined;
    throw error;
  }
};

/** An owner that never recorded a tick is treated as live, so a just-activated install is not displaced. */
const isOwnerStale = async (devrev: DevRevClient, ownerId: string, now: number): Promise<boolean> => {
  const lastTickTs = Number((await getByUniqueKey(devrev, globalKey(ownerId)))?.custom_fields?.[field('last_tick_ts')]);
  return Number.isFinite(lastTickTs) && lastTickTs > 0 && now - lastTickTs * 1000 > STALE_OWNER_MS;
};

/**
 * Two installs polling the same Slack app would each answer every message. The claim is a custom object keyed by
 * Slack app ID; the first install to create it owns the app. Re-claiming by the owner is a no-op. A claim held by an
 * owner that has stopped ticking is taken over, because only a snap-in service account can modify the claim; any
 * other held claim throws SlackAppClaimedError.
 */
export const claimSlackApp = async (
  devrev: DevRevClient,
  appId: string,
  installId: string,
  now: number = Date.now()
): Promise<void> => {
  const uniqueKey = claimKey(appId);
  try {
    await devrev.post('custom-objects.create', {
      custom_fields: { [field('kind')]: 'slack_app_claim', [field('status')]: installId },
      custom_schema_spec: SCHEMA_SPEC,
      leaf_type: STATE_LEAF_TYPE,
      title: uniqueKey,
      unique_key: uniqueKey,
    });
  } catch (error) {
    if (!isStatus(error, 409)) throw error;
    const existing = await getByUniqueKey(devrev, uniqueKey);
    const owner = existing?.custom_fields?.[field('status')];
    if (owner === installId) return;
    if (existing?.id && typeof owner === 'string' && owner && (await isOwnerStale(devrev, owner, now))) {
      await devrev.post('custom-objects.update', {
        custom_fields: { [field('status')]: installId },
        custom_schema_spec: SCHEMA_SPEC,
        id: existing.id,
      });
      console.info(`took over Slack app ${appId} claim from stale install ${owner}`);
      return;
    }
    throw new SlackAppClaimedError(
      `Slack app ${appId} is already connected by another install; use one Slack app per connection`
    );
  }
};

/** Deletes the claim when this install owns it, so a successor or a rollback install can claim the app at once. */
export const releaseSlackApp = async (devrev: DevRevClient, appId: string, installId: string): Promise<void> => {
  const existing = await getByUniqueKey(devrev, claimKey(appId));
  if (!existing?.id || existing.custom_fields?.[field('status')] !== installId) return;
  try {
    await devrev.post('custom-objects.delete', { id: existing.id });
  } catch (error) {
    if (!isStatus(error, 404)) throw error;
  }
};
