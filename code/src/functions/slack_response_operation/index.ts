import { OperationOutput } from '@devrev/typescript-sdk/dist/snap-ins';
import type { FunctionEvent } from '../../types';
import { handleManageSlackResponse } from '../devrev_handler';

// Match the callable entry point and output conversion used by the live QA operations.
const run = async (events: FunctionEvent[]) =>
  OperationOutput.fromJSON(await handleManageSlackResponse(events[0]));

export { run };
export default run;
