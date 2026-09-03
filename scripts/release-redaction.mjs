export const redactKnownTokens = (value) => value
  .replace(/\bnpm_[A-Za-z0-9_-]+/gu, '[REDACTED]')
  .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/gu, '[REDACTED]')
  .replace(/(authorization:\s*Bearer\s+)[^\s]+/giu, '$1[REDACTED]');
