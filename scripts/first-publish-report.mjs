import { inspectTrustedPublishingReadiness } from './release-plan.mjs';

const errorMessage = (error) => error instanceof Error ? error.message : String(error);

export const inspectFirstPublishRegistry = async ({ packages, readMetadata }) => {
  try {
    const states = await Promise.all(packages.map(async ({ name, version }) => {
      const metadata = await readMetadata(name);
      return {
        name,
        version,
        versions: new Set(Object.keys(metadata?.versions ?? {})),
      };
    }));
    const readiness = inspectTrustedPublishingReadiness(states);
    if (readiness.state === 'READY') {
      return {
        ...readiness,
        message: 'FIRST_PUBLISH_READY: every public package already exists in the canonical registry.',
      };
    }
    const packagesText = readiness.packages.map(({ bootstrapEligible, name, version }) => (
      `${name}@${version}${bootstrapEligible ? ' (bootstrap eligible)' : ' (bootstrap required before this version)'}`
    ));
    return {
      ...readiness,
      message: `FIRST_PUBLISH_REQUIRED: ${packagesText.join(', ')}`,
    };
  } catch (error) {
    return {
      message: `FIRST_PUBLISH_UNKNOWN: canonical registry check failed (${errorMessage(error)}); publish hard gate remains authoritative.`,
      packages: [],
      state: 'FIRST_PUBLISH_UNKNOWN',
    };
  }
};
