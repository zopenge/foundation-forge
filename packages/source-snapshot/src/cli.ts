#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSourceSnapshotCli } from './node/cli-runner.js';

export { runSourceSnapshotCli } from './node/cli-runner.js';

const directInvocation = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (directInvocation) {
  const outcome = await runSourceSnapshotCli();
  process.exitCode = outcome.exitCode;
}
