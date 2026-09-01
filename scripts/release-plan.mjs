export const createReleasePlan = (packageStates) => packageStates.map((state) => ({
  name: state.name,
  needsPublish: !state.versions.has(state.version),
  version: state.version,
}));

export const executeReleasePlan = async (
  releases,
  { ensureTag, pack, publish, tag },
) => {
  for (const release of releases) {
    if (release.needsPublish) {
      const tarball = await pack(release);
      await publish(tarball, tag);
    }
    await ensureTag(release);
  }
};
