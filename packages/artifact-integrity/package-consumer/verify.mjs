import { TextEncoder } from 'node:util';

import { calculateBytesIntegrity } from '@openge/forge-artifact-integrity';
import { calculateBytesIntegritySync } from '@openge/forge-artifact-integrity/node';

const bytes = new TextEncoder().encode('abc');
if ((await calculateBytesIntegrity(bytes)).byteLength !== 3) {
  throw new Error('artifact integrity consumer smoke failed');
}
if (calculateBytesIntegritySync(bytes).byteLength !== 3) {
  throw new Error('synchronous artifact integrity consumer smoke failed');
}
