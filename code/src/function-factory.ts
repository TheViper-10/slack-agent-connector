import devrev_handler from './functions/devrev_handler';
import hook_handler from './functions/hook_handler';
import slack_poller from './functions/slack_poller';

export const functionFactory = {
  devrev_handler,
  hook_handler,
  slack_poller,
} as const;

export type FunctionFactoryType = keyof typeof functionFactory;
