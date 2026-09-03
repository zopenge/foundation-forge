const matchesExpectedConfiguration = (configuration, expected) => configuration?.type === 'github'
  && configuration.file === expected.file
  && configuration.repository === expected.repository
  && configuration.environment === expected.environment;

export const redactSecrets = (value, secrets) => secrets.reduce(
  (result, secret) => secret === '' ? result : result.replaceAll(secret, '[REDACTED]'),
  redactKnownTokens(value),
);

export const ensureTrustedPublisherConfigurations = async ({
  configure,
  expected,
  listConfigurations,
  packageNames,
}) => {
  const results = [];
  for (const name of packageNames) {
    if ((await listConfigurations(name)).some((value) => matchesExpectedConfiguration(value, expected))) {
      results.push({ action: 'unchanged', name });
      continue;
    }
    await configure(name);
    if (!(await listConfigurations(name)).some((value) => matchesExpectedConfiguration(value, expected))) {
      throw new Error(`trusted publisher verification failed for ${name}`);
    }
    results.push({ action: 'configured', name });
  }
  return results;
};
import { redactKnownTokens } from './release-redaction.mjs';
