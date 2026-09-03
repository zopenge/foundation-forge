const valueOptions = new Set(['--mode', '--package', '--sha']);
const flagOptions = new Set(['--logs', '--retry']);

export const parseReleaseArguments = (argv) => {
  const parsed = { logs: false, mode: undefined, packages: [], retry: false, sha: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (flagOptions.has(argument)) {
      parsed[argument.slice(2)] = true;
      continue;
    }
    if (!valueOptions.has(argument)) throw new Error(`unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for ${argument}`);
    }
    index += 1;
    if (argument === '--package') parsed.packages.push(value);
    else parsed[argument.slice(2)] = value;
  }
  if (parsed.mode !== undefined && !['bootstrap', 'next', 'stable'].includes(parsed.mode)) {
    throw new Error(`unsupported release mode: ${parsed.mode}`);
  }
  return parsed;
};
