import process from 'node:process';
import { acquireLocalDirectoryLease } from '@openge/forge-process-control-node';
import { readRetirementHost, retirementLeaseNamespace } from '../../dist/node/retirement-host.js';
import { captureRetirementSnapshot, retirementDigest } from '../../dist/node/retirement-record.js';
import { claimRetirement } from '../../dist/node/retirement-claim.js';
import { readManagedLocation } from '../../dist/node/managed-recovery.js';
import { readBoundedJson } from '../../dist/node/managed-io.js';
import { claimManagedRecovery } from '../../dist/node/managed-recovery-lock.js';
process.on('disconnect', () => process.exit(0));
process.once('message', async ({ cwd, mode }) => {
  try {
    const { paths } = await readManagedLocation(cwd, 'release.config.json');
    const state = await readBoundedJson(paths.statePath);
    if (mode === 'recover') await claimManagedRecovery(paths, state);
    else {
      const host = await readRetirementHost(), lease = await acquireLocalDirectoryLease(paths.slotRoot,
        { scope: { namespace: retirementLeaseNamespace, discriminator: host.hostId }, expectedIdentity: paths.slotIdentity });
      await claimRetirement(paths, state, retirementDigest(await captureRetirementSnapshot(paths)), lease, () => lease.assertOwned());
    }
    process.send?.({ ready: true });
  } catch (error) { process.stderr.write(String(error)); process.exitCode = 1; process.disconnect(); }
});
