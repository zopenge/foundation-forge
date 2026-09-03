import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyLocalPackages } from './package-consumer-runner.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
await verifyLocalPackages({
  repositoryRoot,
  verificationRoot: resolve(repositoryRoot, '.tmp', 'package-verification'),
});
