export const redactKnownTokens = (value) => value
  .replace(/https:\/\/(?:www\.)?npmjs\.com\/(?:login|auth)(?:[/?#][^\s\\"'<>]*)?/giu, '[REDACTED_AUTH_URL]')
  .replace(/https:\/\/registry\.npmjs\.org\/-\/v1\/(?:login|auth|done)(?:[/?#][^\s\\"'<>]*)?/giu, '[REDACTED_AUTH_URL]')
  .replace(/\bnpm_[A-Za-z0-9_-]+/gu, '[REDACTED]')
  .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/gu, '[REDACTED]')
  .replace(/(authorization[:=]\s*(?:Bearer|Basic)\s+)[^\s]+/giu, '$1[REDACTED]')
  .replace(/((?:otp|one-time password)["'\s:=]+)(?:\d{6,64}|[a-f0-9]{64})\b/giu, '$1[REDACTED]');
