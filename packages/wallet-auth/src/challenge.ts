import type { WalletChallenge, WalletChallengeResult } from './contracts.js';

const invalid = { ok: false, code: 'invalid-challenge' } as const;
const dateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const segment = /^[A-Za-z0-9._~-]{1,128}$/u;

function matches(pattern: RegExp, value: unknown): boolean {
  return typeof value === 'string' && pattern.test(value);
}

function readTime(value: string): number {
  if (!matches(dateTime, value)) return Number.NaN;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return Number.NaN;

  // Date.parse 可能将 2 月 30 日等无效日期归一化。
  return new Date(milliseconds).toISOString().slice(0, 19) === value.slice(0, 19) ? milliseconds : Number.NaN;
}

export function validateWalletChallenge(challenge: WalletChallenge, now: Date): WalletChallengeResult {
  if (!matches(segment, challenge?.id) || !matches(/^[A-Za-z0-9]{8,128}$/u, challenge.nonce) ||
    (challenge.purpose !== 'sign-in' && challenge.purpose !== 'link') ||
    !matches(segment, challenge.account?.namespace) || !matches(segment, challenge.account.network) ||
    !matches(/^[\x21-\x7e]{1,256}$/u, challenge.account.address)
  ) return invalid;

  try {
    const audience = new URL(challenge.audience);
    const uri = new URL(challenge.uri);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(audience.hostname);
    if ((audience.protocol !== 'https:' && !(local && audience.protocol === 'http:')) ||
      audience.origin !== challenge.audience || uri.href !== challenge.uri ||
      uri.origin !== audience.origin || uri.username || uri.password || uri.hash
    ) return invalid;
  } catch {
    return invalid;
  }

  const issued = readTime(challenge.issuedAt);
  const expires = readTime(challenge.expiresAt);
  const time = now.getTime();
  if (!Number.isFinite(time) || !Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued || time < issued) {
    return invalid;
  }
  if (time >= expires) return { ok: false, code: 'expired' };
  return { ok: true };
}
