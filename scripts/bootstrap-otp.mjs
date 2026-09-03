export const parseOneTimePassword = (value) => {
  if (!/^\d{6}$/u.test(value)) {
    throw new Error('npm one-time password must contain exactly six digits');
  }
  return value;
};

export const readMaskedOneTimePassword = (
  input = process.stdin,
  output = process.stdout,
) => new Promise((resolve, reject) => {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    reject(new Error('Bootstrap publishing requires an interactive terminal for npm 2FA'));
    return;
  }

  const previousRawMode = input.isRaw;
  let value = '';
  const cleanup = () => {
    input.off('data', onData);
    input.setRawMode(previousRawMode);
    input.pause();
  };
  const finish = () => {
    output.write('\n');
    cleanup();
    try {
      resolve(parseOneTimePassword(value));
    } catch (error) {
      reject(error);
    }
  };
  const onData = (chunk) => {
    for (const character of String(chunk)) {
      if (character === '\u0003') {
        output.write('\n');
        cleanup();
        reject(new Error('Bootstrap publishing cancelled'));
        return;
      }
      if (character === '\r' || character === '\n') {
        finish();
        return;
      }
      if (character === '\b' || character === '\u007f') {
        if (value.length > 0) {
          value = value.slice(0, -1);
          output.write('\b \b');
        }
        continue;
      }
      if (/\d/u.test(character) && value.length < 6) {
        value += character;
        output.write('*');
      }
    }
  };

  output.write('npm one-time password: ');
  input.setEncoding('utf8');
  input.setRawMode(true);
  input.resume();
  input.on('data', onData);
});
