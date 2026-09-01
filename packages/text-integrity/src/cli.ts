#!/usr/bin/env node

import { runTextIntegrityCli } from './node.js';

runTextIntegrityCli()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
