#!/usr/bin/env node
import { runWorkspaceChecksCli } from './cli-runner.js';

const status = await runWorkspaceChecksCli(process.argv.slice(2), {
  stderr: (value) => process.stderr.write(value),
  stdout: (value) => process.stdout.write(value),
}, process.cwd());
process.exitCode = status;
