export interface FunctionEvent {
  context: {
    dev_oid: string;
    service_account_id?: string;
    snap_in_id: string;
    secrets: { service_account_token: string };
  };
  execution_metadata: {
    devrev_endpoint: string;
    event_type: string;
    function_name?: string;
    request_id?: string;
  };
  input_data: {
    event_sources: Record<string, string>;
    global_values?: Record<string, string>;
    keyrings?: Record<string, KeyringResource>;
    resources?: { keyrings?: Record<string, KeyringResource> };
  };
  payload: Record<string, unknown>;
}

export interface KeyringResource {
  external_org_id?: string;
  secret: string;
}

export type HookResponse = {
  id: string;
  inputs_values: Record<string, string>;
};

export interface SyncFunctionResponse {
  event?: Record<string, unknown>;
  event_type?: string;
  response: {
    body?: Record<string, unknown>;
    status_code: number;
    success: boolean;
  };
}

export const getKeyring = (event: FunctionEvent, name: string): KeyringResource | undefined =>
  event.input_data.resources?.keyrings?.[name] ?? event.input_data.keyrings?.[name];
