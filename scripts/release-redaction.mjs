export const redactKnownTokens = (value) => value
  .replace(/\bnpm_[A-Za-z0-9_-]+/gu, '[REDACTED]')
  .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/gu, '[REDACTED]')
  .replace(/(authorization[:=]\s*(?:Bearer|Basic)\s+)[^\s]+/giu, '$1[REDACTED]')
  .replace(/((?:otp|one-time password)["'\s:=]+)\d{6}\b/giu, '$1[REDACTED]');
