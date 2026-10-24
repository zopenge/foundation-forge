import process from 'node:process';
import { acquireRetirementLease } from '../../dist/node/retirement-lease.js';
import { readRetirementHost } from '../../dist/node/retirement-host.js';
import { captureRetirementSnapshot, retirementDigest } from '../../dist/node/retirement-record.js';
import { claimRetirement } from '../../dist/node/retirement-claim.js';
import { readManagedLocation } from '../../dist/node/managed-recovery.js';
import { readBoundedJson } from '../../dist/node/managed-io.js';
process.on('disconnect', () => process.exit(0));
process.once('message', async ({ cwd }) => {
  try {
    const { paths } = await readManagedLocation(cwd, 'release.config.json');
    const state = await readBoundedJson(paths.statePath), host = await readRetirementHost();
    const lease = await acquireRetirementLease(paths, host);
    await claimRetirement(paths, state, retirementDigest(await captureRetirementSnapshot(paths)), lease, () => lease.assertOwned());
    process.send?.({ ready: true });
  } catch (error) { process.stderr.write(String(error)); process.exitCode = 1; process.disconnect(); }
});
