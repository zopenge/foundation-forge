import { recordTestWorkerEvent } from './test-worker-events.mjs';
import { resolve } from 'node:path';

if (process.argv[1]
  && resolve(process.argv[1]) === process.env.FORGE_NODE_TEST_FILE) {
  recordTestWorkerEvent('start', { kind: 'node-test' });
  process.once('exit', () => recordTestWorkerEvent('finish', { kind: 'node-test' }));
}
