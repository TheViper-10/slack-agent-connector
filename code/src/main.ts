import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { functionFactory, type FunctionFactoryType } from './function-factory';
import type { FunctionEvent } from './types';

const main = async (): Promise<void> => {
  const argv = await yargs(hideBin(process.argv))
    .option('fixturePath', { demandOption: true, type: 'string' })
    .option('functionName', { choices: Object.keys(functionFactory) as FunctionFactoryType[], demandOption: true })
    .parse();
  const fixture = JSON.parse(await readFile(resolve('src/fixtures', argv.fixturePath), 'utf8')) as FunctionEvent;
  const handler = functionFactory[argv.functionName];
  if (typeof handler !== 'function') throw new Error('Operation maps use the SDK operation runner.');
  await handler([fixture]);
};

void main();
