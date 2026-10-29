import { recordTestWorkerEvent } from './test-worker-events.mjs';

recordTestWorkerEvent('start', { kind: 'consumer' });
process.once('exit', () => recordTestWorkerEvent('finish', { kind: 'consumer' }));
