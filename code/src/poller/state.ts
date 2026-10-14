import axios from 'axios';

import { APP_NAME } from '../agent/constants';
import type { DevRevClient } from '../clients/devrev';

export const STATE_LEAF_TYPE = 'slack_connector_state';
export const RECEIPT_LEAF_TYPE = 'slack_connector_receipt';

const field = (name: string): string => `app_${APP_NAME}__${name}`;
const SCHEMA_SPEC = { apps: [APP_NAME], tenant_fragment: true };

export type StateKind = 'channel' | 'global' | 'thread' | 'response';

export interface StateRecord {
  activeUntil?: string;
  channel?: string;
  id: string;
  kind: StateKind;
  lastTickTs?: string;
  /** Channel/thread: last fully processed Slack ts. Global: Slack ts of the first tick (install marker). */
  lastTs?: string;
  status?: string;
  threadTs?: string;
  uniqueKey: string;
}

export type ReceiptStatus = 'claimed' | 'done';

export interface Receipt {
  claimedAt: number;
  dmObject?: string;
  id: string;
  status: ReceiptStatus;
}

/** Slack event facts stored on the receipt in workflow invoke mode so a workflow can act on it without Slack access. */
export interface ReceiptPayload {
  /** The message's own thread_ts; empty for a top-level message. */
  parentTs?: string;
  sender: string;
  senderName?: string;
  text: string;
  /** Earlier messages of the thread, oldest first, one per line. */
  threadContext?: string;
}

export type ClaimResult = { claimed: true; receipt: Receipt } | { claimed: false; existing: Receipt };

/** Durable poller state: per-channel cursors, thread watches, and write-ahead dispatch receipts. */
export interface StateStore {
  claimReceipt(
    channel: string,
    messageTs: string,
    threadTs: string,
    now: number,
    payload?: ReceiptPayload
  ): Promise<ClaimResult>;
  completeReceipt(receipt: Receipt): Promise<void>;
  deleteState(record: StateRecord): Promise<void>;
  getState(uniqueKey: string): Promise<StateRecord | undefined>;
  listState(): Promise<StateRecord[]>;
  reclaimReceipt(receipt: Receipt, now: number): Promise<Receipt>;
  recordReceiptDm(receipt: Receipt, dmObject: string): Promise<void>;
  saveState(record: Omit<StateRecord, 'id'> & { id?: string }): Promise<StateRecord>;
}

/**
 * custom-objects unique keys are org-wide across every leaf type and app, and one org can hold several installs of
 * this snap-in. Every key is therefore namespaced with the app name and the install ID, so installs never share
 * cursors or receipts.
 */
export const keyPrefix = (installId: string): string => `${APP_NAME}:${installId.split('/').pop() ?? installId}:`;
export const globalKey = (installId: string): string => `${keyPrefix(installId)}global`;
export const channelKey = (installId: string, channel: string): string => `${keyPrefix(installId)}channel:${channel}`;
export const threadKey = (installId: string, channel: string, threadTs: string): string =>
  `${keyPrefix(installId)}thread:${channel}:${threadTs}`;
export const receiptKey = (installId: string, channel: string, messageTs: string): string =>
  `${keyPrefix(installId)}receipt:${channel}:${messageTs}`;

interface CustomObject {
  custom_fields?: Record<string, unknown>;
  id?: string;
  leaf_type?: string;
  unique_key?: string;
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

const isStatus = (error: unknown, status: number): boolean =>
  axios.isAxiosError(error) && error.response?.status === status;

const toStateRecord = (object: CustomObject): StateRecord | undefined => {
  const fields = object.custom_fields ?? {};
  const kind = str(fields[field('kind')]) as StateKind | undefined;
  if (!object.id || !object.unique_key || !kind) return undefined;
  return {
    activeUntil: str(fields[field('active_until')]),
    channel: str(fields[field('channel')]),
    id: object.id,
    kind,
    lastTickTs: str(fields[field('last_tick_ts')]),
    lastTs: str(fields[field('last_ts')]),
    status: str(fields[field('status')]),
    threadTs: str(fields[field('thread_ts')]),
    uniqueKey: object.unique_key,
  };
};

const toReceipt = (object: CustomObject): Receipt => {
  const fields = object.custom_fields ?? {};
  return {
    claimedAt: Number(str(fields[field('claimed_at')]) ?? 0),
    dmObject: str(fields[field('dm_object')]),
    id: object.id ?? '',
    status: (str(fields[field('status')]) as ReceiptStatus | undefined) ?? 'claimed',
  };
};

const stateFields = (record: Omit<StateRecord, 'id'>): Record<string, string> => ({
  [field('active_until')]: record.activeUntil ?? '',
  [field('channel')]: record.channel ?? '',
  [field('kind')]: record.kind,
  [field('last_tick_ts')]: record.lastTickTs ?? '',
  [field('last_ts')]: record.lastTs ?? '',
  [field('status')]: (record.status ?? '').slice(0, 1000),
  [field('thread_ts')]: record.threadTs ?? '',
});

export const RECEIPT_TEXT_LIMIT = 8000;
export const RECEIPT_CONTEXT_LIMIT = 8000;

const receiptPayloadFields = (payload: ReceiptPayload): Record<string, string> => ({
  [field('parent_ts')]: payload.parentTs ?? '',
  [field('sender')]: payload.sender,
  [field('sender_name')]: payload.senderName ?? '',
  [field('text')]: payload.text.slice(0, RECEIPT_TEXT_LIMIT),
  [field('thread_context')]: (payload.threadContext ?? '').slice(0, RECEIPT_CONTEXT_LIMIT),
});

/** Read-only visibility for an operator: objects created by the service account are otherwise private to it. */
export interface StateViewer {
  member: string;
  receiptRole?: string;
  stateRole?: string;
}

/** Resolves the per-leaf-type Viewer roles so state objects can be shared read-only with an operator. */
export const resolveStateViewer = async (
  devrev: DevRevClient,
  member: string | undefined
): Promise<StateViewer | undefined> => {
  if (!member) return undefined;
  const viewerRole = async (leafType: string): Promise<string | undefined> => {
    try {
      const response = await devrev.post<{ roles?: Array<{ id?: string; name?: string; privileges?: string[] }> }>(
        'roles.list',
        { custom_object_target: [leafType], is_object_member_type: true }
      );
      return response.roles?.find((role) => role.name === 'Viewer')?.id;
    } catch (error) {
      console.warn(`could not resolve Viewer role for ${leafType}:`, error instanceof Error ? error.message : error);
      return undefined;
    }
  };
  const [stateRole, receiptRole] = await Promise.all([viewerRole(STATE_LEAF_TYPE), viewerRole(RECEIPT_LEAF_TYPE)]);
  if (!stateRole && !receiptRole) return undefined;
  return { member, receiptRole, stateRole };
};

export class DevRevStateStore implements StateStore {
  private readonly prefix: string;

  constructor(
    private readonly devrev: DevRevClient,
    private readonly installId: string,
    private readonly viewer?: StateViewer
  ) {
    this.prefix = keyPrefix(installId);
  }

  private shareOnCreate(role: string | undefined): Record<string, unknown> {
    return this.viewer && role ? { shared_with: [{ member: this.viewer.member, role }] } : {};
  }

  private shareOnUpdate(role: string | undefined): Record<string, unknown> {
    return this.viewer && role ? { shared_with: { upsert: [{ member: this.viewer.member, role }] } } : {};
  }

  private async getByUniqueKey(uniqueKey: string, leafType: string): Promise<CustomObject | undefined> {
    try {
      const response = await this.devrev.post<{ custom_object?: CustomObject }>('custom-objects.get', {
        unique_key: uniqueKey,
      });
      const object = response.custom_object;
      if (object?.leaf_type && object.leaf_type !== leafType) {
        throw new Error(`unique_key ${uniqueKey} belongs to leaf type ${object.leaf_type}, expected ${leafType}`);
      }
      return object;
    } catch (error) {
      if (isStatus(error, 404)) return undefined;
      throw error;
    }
  }

  async getState(uniqueKey: string): Promise<StateRecord | undefined> {
    const object = await this.getByUniqueKey(uniqueKey, STATE_LEAF_TYPE);
    return object ? toStateRecord(object) : undefined;
  }

  async listState(): Promise<StateRecord[]> {
    const records: StateRecord[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.devrev.post<{ next_cursor?: string; result?: CustomObject[] }>(
        'custom-objects.list',
        { leaf_type: STATE_LEAF_TYPE, limit: 100, ...(cursor ? { cursor } : {}) }
      );
      for (const object of response.result ?? []) {
        const record = toStateRecord(object);
        // Ignore objects outside this install's key namespace (other installs, or earlier builds).
        if (record?.uniqueKey.startsWith(this.prefix)) records.push(record);
      }
      cursor = response.next_cursor || undefined;
    } while (cursor);
    return records;
  }

  async saveState(record: Omit<StateRecord, 'id'> & { id?: string }): Promise<StateRecord> {
    const { id, ...rest } = record;
    if (id) {
      await this.devrev.post('custom-objects.update', {
        custom_fields: stateFields(rest),
        custom_schema_spec: SCHEMA_SPEC,
        id,
        ...this.shareOnUpdate(this.viewer?.stateRole),
      });
      return { ...rest, id };
    }
    try {
      const response = await this.devrev.post<{ custom_object?: CustomObject }>('custom-objects.create', {
        custom_fields: stateFields(rest),
        custom_schema_spec: SCHEMA_SPEC,
        leaf_type: STATE_LEAF_TYPE,
        ...this.shareOnCreate(this.viewer?.stateRole),
        title: rest.uniqueKey,
        unique_key: rest.uniqueKey,
      });
      return { ...rest, id: response.custom_object?.id ?? '' };
    } catch (error) {
      // A concurrent tick created it first; update the existing object instead.
      if (!isStatus(error, 409)) throw error;
      const existing = await this.getByUniqueKey(rest.uniqueKey, STATE_LEAF_TYPE);
      if (!existing?.id) throw error;
      return this.saveState({ ...rest, id: existing.id });
    }
  }

  async deleteState(record: StateRecord): Promise<void> {
    try {
      await this.devrev.post('custom-objects.delete', { id: record.id });
    } catch (error) {
      if (!isStatus(error, 404)) throw error;
    }
  }

  async claimReceipt(
    channel: string,
    messageTs: string,
    threadTs: string,
    now: number,
    payload?: ReceiptPayload
  ): Promise<ClaimResult> {
    const uniqueKey = receiptKey(this.installId, channel, messageTs);
    try {
      const response = await this.devrev.post<{ custom_object?: CustomObject }>('custom-objects.create', {
        custom_fields: {
          [field('channel')]: channel,
          [field('claimed_at')]: String(now),
          [field('message_ts')]: messageTs,
          [field('status')]: 'claimed',
          [field('thread_ts')]: threadTs,
          ...(payload ? receiptPayloadFields(payload) : {}),
        },
        custom_schema_spec: SCHEMA_SPEC,
        leaf_type: RECEIPT_LEAF_TYPE,
        ...this.shareOnCreate(this.viewer?.receiptRole),
        title: uniqueKey,
        unique_key: uniqueKey,
      });
      return { claimed: true, receipt: { claimedAt: now, id: response.custom_object?.id ?? '', status: 'claimed' } };
    } catch (error) {
      if (!isStatus(error, 409)) throw error;
      const existing = await this.getByUniqueKey(uniqueKey, RECEIPT_LEAF_TYPE);
      if (!existing) throw error;
      return { claimed: false, existing: toReceipt(existing) };
    }
  }

  async reclaimReceipt(receipt: Receipt, now: number): Promise<Receipt> {
    await this.devrev.post('custom-objects.update', {
      custom_fields: { [field('claimed_at')]: String(now), [field('status')]: 'claimed' },
      custom_schema_spec: SCHEMA_SPEC,
      id: receipt.id,
    });
    return { ...receipt, claimedAt: now, status: 'claimed' };
  }

  async recordReceiptDm(receipt: Receipt, dmObject: string): Promise<void> {
    await this.devrev.post('custom-objects.update', {
      custom_fields: { [field('dm_object')]: dmObject },
      custom_schema_spec: SCHEMA_SPEC,
      id: receipt.id,
    });
  }

  async completeReceipt(receipt: Receipt): Promise<void> {
    await this.devrev.post('custom-objects.update', {
      custom_fields: { [field('status')]: 'done' },
      custom_schema_spec: SCHEMA_SPEC,
      id: receipt.id,
    });
  }
}
