import { posix, win32 } from 'node:path';
import { assertActive, ReleaseError } from './errors.js';

export interface ArtifactFile { readonly path: string; readonly sha256: string; readonly byteLength: number; readonly mode: number }
export interface ArtifactDirectory { readonly path: string; readonly mode: number }
export interface ArtifactLinkInput { readonly path: string; readonly target: string; readonly mode: number }
export interface ArtifactLink extends ArtifactLinkInput { readonly kind: 'file' | 'directory'; readonly resolvedPath: string }
export interface ArtifactInventory {
  readonly files: readonly ArtifactFile[]; readonly directories: readonly ArtifactDirectory[];
  readonly links: readonly ArtifactLink[]; readonly byteLength: number;
}
export const artifactInvalid = (reason: string): never => { throw new ReleaseError('ARTIFACT_INVALID', { reason }); };
export function artifactGuard(signal: AbortSignal | undefined, deadline: number): void {
  assertActive(signal); if (Date.now() >= deadline) throw new ReleaseError('BUDGET_EXCEEDED', { reason: 'ARTIFACT_DEADLINE' });
}
export function artifactPath(path: string): void {
  if (Buffer.byteLength(path) > 1024 || path.split('/').some(part => !part || part === '.' || part === '..'
    || Buffer.byteLength(part) > 255 || /[<>:"\\|?*]/u.test(part) || [...part].some(value => value.charCodeAt(0) < 32 || value.charCodeAt(0) === 127) || /[. ]$/u.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)
    || /^(?:\.git|\.env(?:\..*)?|\.npmrc|\.netrc|id_rsa|id_ed25519)$/iu.test(part))) artifactInvalid('UNSAFE_PATH');
}
export function artifactLinkTarget(raw: string): string {
  const target = process.platform === 'win32' ? raw.replaceAll('\\', '/') : raw;
  if (!target || Buffer.byteLength(target) > 1024 || posix.isAbsolute(target) || win32.isAbsolute(target) || /^[a-z]:/iu.test(target)) artifactInvalid('LINK_ABSOLUTE');
  for (const part of target.split('/')) if (part && part !== '.' && part !== '..') artifactPath(part);
  return target;
}
