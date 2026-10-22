const pnpmKeys = new Set(['npm-globalconfig', 'package-extensions', 'prefer-workspace-packages',
  'strict-peer-dependencies', 'verify-deps-before-run', 'auto-install-peers']);
const configName = (key) => key.toLowerCase().replace(/^npm_config_/u, '').replaceAll('_', '-');

export const createNpmEnvironment = (environment = process.env) => Object.fromEntries(
  Object.entries(environment).filter(([key]) => !(/^npm_config_/iu.test(key)
    && (pnpmKeys.has(configName(key)) || /^npm_config__.+_registry$/iu.test(key)))),
);

const transportKeys = new Set(['proxy', 'https-proxy', 'noproxy', 'strict-ssl', 'cafile',
  'certfile', 'keyfile', 'cache', 'cache-dir', 'store-dir']);

export const createPublicConsumerEnvironment = (environment, emptyConfig) => ({
  ...Object.fromEntries(Object.entries(environment).filter(([key]) => {
    if (/^(?:NPM_TOKEN|NODE_AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN|ACTIONS_ID_TOKEN_REQUEST_.+)$/iu.test(key)) return false;
    return !/^npm_config_/iu.test(key) || transportKeys.has(configName(key));
  })),
  NPM_CONFIG_USERCONFIG: emptyConfig,
  NPM_CONFIG_GLOBALCONFIG: emptyConfig,
  CI: 'true',
});
