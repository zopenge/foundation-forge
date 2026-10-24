import { parseOneTimePassword, readMaskedOneTimePassword } from './bootstrap-otp.mjs';

const validateMode = (authMode) => {
  if (!['otp', 'web'].includes(authMode)) throw new Error(`unsupported --auth-mode: ${authMode}`);
  return authMode;
};

export const parseReleaseAuthenticationArguments = (argv) => {
  let authMode = 'otp';
  let seen = false;
  const args = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--auth-mode') { args.push(argv[index]); continue; }
    if (seen) throw new Error('duplicate --auth-mode');
    seen = true;
    authMode = validateMode(argv[++index]);
  }
  return { authMode, args };
};

export const removeNpmOtp = (environment) => Object.fromEntries(Object.entries(environment)
  .filter(([key]) => !/^npm_config_otp$/iu.test(key)));

export const readReleaseAuthentication = async ({ authMode = 'otp', environment = process.env,
  input = process.stdin, output = process.stdout,
  readOtp = () => environment.NPM_CONFIG_OTP === undefined
    ? readMaskedOneTimePassword(input, output) : parseOneTimePassword(environment.NPM_CONFIG_OTP),
} = {}) => {
  validateMode(authMode);
  const result = removeNpmOtp(environment);
  if (authMode === 'web') {
    if (!input.isTTY || !output.isTTY) {
      throw new Error('WEB_AUTH_REQUIRES_TTY：网页授权需要真实终端的输入和输出');
    }
    return result;
  }
  return { ...result, NPM_CONFIG_OTP: parseOneTimePassword(await readOtp()) };
};

export const npmAuthenticationArguments = (authMode = 'otp') => validateMode(authMode) === 'web'
  ? ['--auth-type=web', '--browser=false', '--otp=', '--json=false'] : [];
