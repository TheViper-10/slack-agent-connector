import type { FunctionEvent } from '../../types';
import { handleManageSlackResponse } from './index';

// Native SDK OperationMap entry. Ordinary event functions are not operation handlers.
// Context construction follows SDK OperationBase.GetContext; no model-supplied identity.
export class SlackResponseOperation {
  constructor(private readonly event: FunctionEvent) {}

  GetContext() {
    const context = this.event.context as FunctionEvent['context'] & {
      workflow_context?: Record<string, string>;
      headers?: Record<string, unknown>;
    };
    const secrets = context.secrets as Record<string, string>;
    return {
      devrev_endpoint: this.event.execution_metadata.devrev_endpoint,
      secrets: { access_token: secrets['access_token'], service_account_token: secrets['service_account_token'] },
      dev_oid: context.dev_oid,
      input_port: String(this.event.payload['input_port_name'] || 'input'),
      workflow_context: context.workflow_context,
      headers: context.headers,
    };
  }

  async run(_metadata: unknown, input: Record<string, unknown>, _resources: Record<string, unknown>) {
    const workflowRun = this.GetContext().workflow_context?.['workflow_run_id'];
    return handleManageSlackResponse({
      ...this.event,
      payload: { ...this.event.payload, data: { ...input, ...(workflowRun ? { workflow_run_id: workflowRun } : {}) } },
    });
  }
}
