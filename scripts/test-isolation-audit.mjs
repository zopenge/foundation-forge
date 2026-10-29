// 固定诊断允许列表；报告只含键名、计数和布尔，不保存路径或环境值。
export const isolationEnvironmentNames = Object.freeze([
  'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'PNPM_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME',
  'npm_config_store_dir', 'npm_config_cache_dir', 'npm_config_state_dir', 'npm_config_userconfig', 'npm_config_globalconfig',
  'NODE_COMPILE_CACHE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_TEMPLATE_DIR', 'PSModuleAnalysisCachePath',
]);

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export const auditIsolationEnvironment = ({ expected, actual, platform }) => {
  const supported = platform === 'win32' || platform === 'posix';
  const canonical = name => platform === 'win32' ? name.toUpperCase() : name;
  const names = isolationEnvironmentNames.map(canonical), allowed = new Set(names);
  const index = value => {
    const result = new Map();
    if (isRecord(value)) for (const name of Object.keys(value)) {
      const key = canonical(name);
      if (allowed.has(key)) result.set(key, [...(result.get(key) ?? []), value[name]]);
    }
    return result;
  };
  const expectedIndex = index(expected), actualIndex = index(actual);
  const unexpectedExpectedFields = isRecord(expected) && Object.keys(expected).some(name => !allowed.has(canonical(name)));
  const fields = names.map(name => {
    const wanted = expectedIndex.get(name) ?? [], found = actualIndex.get(name) ?? [];
    const conflict = new Set(wanted).size > 1 || new Set(found).size > 1;
    const typeValid = wanted.every(value => typeof value === 'string') && found.every(value => typeof value === 'string');
    const present = found.length > 0, expectedPresent = wanted.length > 0;
    return { name, expectedPresent, present, aliases: found.length, typeValid, conflict,
      match: expectedPresent && present && typeValid && !conflict && found[0] === wanted[0] };
  });
  return { schemaVersion: 1, platform: supported ? platform : 'unsupported',
    expectedValid: isRecord(expected), actualValid: isRecord(actual), unexpectedExpectedFields,
    matches: supported && isRecord(expected) && isRecord(actual) && !unexpectedExpectedFields && fields.every(field => field.match), fields };
};
