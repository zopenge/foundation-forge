export const createReleasePlan = (packageStates) => packageStates.map((state) => ({
  isBootstrapped: state.versions.size > 0,
  name: state.name,
  needsPublish: !state.versions.has(state.version),
  version: state.version,
}));

const prereleaseVersionPattern = /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/u;

export const hasPrereleaseVersion = (releases) => releases.some(
  ({ version }) => prereleaseVersionPattern.test(version),
);

export const assertNextReleasePlan = (releases) => {
  const stableRelease = releases.find(
    ({ needsPublish, version }) => needsPublish && !prereleaseVersionPattern.test(version),
  );
  if (stableRelease !== undefined) {
    throw new Error(
      `${stableRelease.name}@${stableRelease.version} cannot be published with the next tag`,
    );
  }
};

export const assertTrustedPublishingReady = (packageStates) => {
  const unbootstrappedPackage = packageStates.find(({ versions }) => versions.size === 0);
  if (unbootstrappedPackage !== undefined) {
    throw new Error(
      `${unbootstrappedPackage.name}@${unbootstrappedPackage.version} must be bootstrapped before workflow publishing`,
    );
  }
};

const bootstrapVersionPattern = /^\d+\.\d+\.\d+-rc\.0$/u;

export const assertBootstrapReleasePlan = (releases) => {
  const invalidRelease = releases.find(
    ({ isBootstrapped, needsPublish, version }) => needsPublish
      && (isBootstrapped || !bootstrapVersionPattern.test(version)),
  );
  if (invalidRelease !== undefined) {
    throw new Error(
      `${invalidRelease.name}@${invalidRelease.version}: bootstrap publishing requires a brand-new rc.0 package`,
    );
  }
};

export const createNpmPublishArguments = (
  tarball,
  { provenance = true, tag } = {},
) => {
  const args = ['publish', tarball, '--access', 'public'];
  if (provenance) {
    args.push('--provenance');
  }
  if (tag !== undefined) {
    args.push('--tag', tag);
  }
  return args;
};

export const executeReleasePlan = async (
  releases,
  { ensureTag, pack, publish, tag, verifyTag },
) => {
  for (const release of releases) {
    if (release.needsPublish) {
      const tarball = await pack(release);
      await publish(tarball, tag);
      await ensureTag(release);
    } else {
      await verifyTag(release);
    }
  }
};
