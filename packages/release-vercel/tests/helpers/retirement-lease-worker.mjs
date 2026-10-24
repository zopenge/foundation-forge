import { acquireRetirementLease } from '../../dist/node/retirement-lease.js';
import process from 'node:process';
process.on('disconnect', () => process.exit(0));
process.once('message', async ({ paths, host }) => {
  try { await acquireRetirementLease(paths, host); process.send?.({ ready: true }); }
  catch (error) { process.stderr.write(String(error)); process.exitCode = 1; process.disconnect(); }
});
