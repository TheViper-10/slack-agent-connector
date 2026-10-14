import devrev_handler from './functions/devrev_handler';
import hook_handler from './functions/hook_handler';
import slack_poller from './functions/slack_poller';
import slack_response_operation from './functions/slack_response_operation';

export const functionFactory = {
  devrev_handler,
  hook_handler,
  slack_poller,
  slack_response_operation,
} as const;

export type FunctionFactoryType = keyof typeof functionFactory;
