import { APP_NAME } from '../../agent/constants';
import type { DevRevClient } from '../../clients/devrev';
import { RECEIPT_LEAF_TYPE, STATE_LEAF_TYPE } from '../../poller/state';

const field = (name: string) => ({ field_type: 'text', name, ui: { is_hidden: true } });
const labeledField = (name: string, displayName: string) => ({
  field_type: 'text',
  name,
  ui: { display_name: displayName, is_hidden: true },
});

export const installDmSchema = async (devrev: DevRevClient): Promise<void> => {
  await devrev.post('schemas.custom.set', {
    app: APP_NAME,
    app_display_name: 'Slack Agent Connector',
    description: 'Hidden fields used to relay agent DM responses to Slack.',
    fields: [
      field('slack_channel'),
      field('slack_thread_ts'),
      field('prompt_ts'),
      field('agent_svcacc'),
      field('last_imported_ts'),
    ],
    leaf_type: 'dm',
    type: 'app_fragment',
  });
};

const installLeafType = async (
  devrev: DevRevClient,
  leafType: string,
  idPrefix: string,
  displayName: string,
  description: string,
  fields: ReturnType<typeof labeledField>[]
): Promise<void> => {
  // Tenant fragment defines the custom leaf type; the app fragment owns its fields. Both writes are idempotent.
  await devrev.post('schemas.custom.set', {
    description,
    fields: [],
    id_prefix: idPrefix,
    is_custom_leaf_type: true,
    leaf_type: leafType,
    leaf_type_display_name: displayName,
    type: 'tenant_fragment',
  });
  await devrev.post('schemas.custom.set', {
    app: APP_NAME,
    app_display_name: 'Slack Agent Connector',
    description,
    fields,
    is_custom_leaf_type: true,
    leaf_type: leafType,
    type: 'app_fragment',
  });
};

export const installPollerSchema = async (devrev: DevRevClient): Promise<void> => {
  await installLeafType(
    devrev,
    STATE_LEAF_TYPE,
    'SCCS',
    'Slack Connector Poll State',
    'Slack polling cursors, thread watches, and tick status for Slack Agent Connector.',
    [
      labeledField('kind', 'Kind'),
      labeledField('channel', 'Slack channel'),
      labeledField('thread_ts', 'Slack thread ts'),
      labeledField('last_ts', 'Last processed ts'),
      labeledField('active_until', 'Watch until (epoch s)'),
      labeledField('last_tick_ts', 'Last tick ts'),
      labeledField('status', 'Status'),
    ]
  );
  await installLeafType(
    devrev,
    RECEIPT_LEAF_TYPE,
    'SCCR',
    'Slack Connector Dispatch Receipt',
    'Write-ahead dispatch receipts for Slack messages handled by Slack Agent Connector.',
    [
      labeledField('channel', 'Slack channel'),
      labeledField('message_ts', 'Message ts'),
      labeledField('thread_ts', 'Thread ts'),
      labeledField('status', 'Status'),
      labeledField('claimed_at', 'Claimed at (epoch ms)'),
      labeledField('dm_object', 'DevRev DM'),
      // Filled only in workflow invoke mode: the Slack event facts a workflow needs.
      labeledField('text', 'Message text'),
      labeledField('sender', 'Sender Slack user ID'),
      labeledField('sender_name', 'Sender display name'),
      labeledField('parent_ts', 'Message thread_ts (empty when top-level)'),
      labeledField('thread_context', 'Earlier thread messages'),
    ]
  );
};
