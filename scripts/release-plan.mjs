export const createReleasePlan = (packageStates) => packageStates.map((state) => ({
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
