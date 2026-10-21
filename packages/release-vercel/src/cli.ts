#!/usr/bin/env node
import { runCli } from './cli-runner.js';

await runCli(process.argv.slice(2));
