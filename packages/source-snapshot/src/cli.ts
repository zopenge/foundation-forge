#!/usr/bin/env node

import { runSourceSnapshotCli } from './node/cli-runner.js';

export { runSourceSnapshotCli } from './node/cli-runner.js';

const outcome = await runSourceSnapshotCli();
process.exitCode = outcome.exitCode;
