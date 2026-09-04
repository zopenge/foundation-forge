import { validatePortableRelativePath } from '@openge/forge-path-safety';
import { generatedArtifactErrorCodes as codes, type GeneratedArtifactPlan, type GeneratedArtifactPlanInput } from './contracts.js';
import { GeneratedArtifactError } from './errors.js';

export function validateArtifactPath(path: string): string {
  try {
    if (typeof path !== 'string' || /[<>:"|?*]/u.test(path) || [...path].some(character => character.charCodeAt(0) < 32)
      || path.split('/').some(segment => /[. ]$/u.test(segment) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment))) {
      throw new GeneratedArtifactError(codes.invalidPath, { path });
    }
    return validatePortableRelativePath(path);
  } catch (cause) {
    throw new GeneratedArtifactError(codes.invalidPath, { path }, cause);
  }
}

export function defineGeneratedArtifactPlan(input: GeneratedArtifactPlanInput): GeneratedArtifactPlan {
  const expected = new Set<string>();
  const retired = new Set<string>();
  const artifacts = input.artifacts.map(artifact => {
    const path = validateArtifactPath(artifact.path);
    if (expected.has(path)) throw new GeneratedArtifactError(codes.duplicatePath, { path });
    expected.add(path);
    const comparison = artifact.comparison ?? 'exact';
    if ((typeof artifact.content !== 'string' && !(artifact.content instanceof Uint8Array))
      || (comparison !== 'exact' && comparison !== 'normalize-newlines')
      || (comparison === 'normalize-newlines' && typeof artifact.content !== 'string')) {
      throw new GeneratedArtifactError(codes.invalidContent, { path });
    }
    return Object.freeze({ path, content: typeof artifact.content === 'string' ? artifact.content : new Uint8Array(artifact.content), comparison });
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const retiredPaths = (input.retiredPaths ?? []).map(value => {
    const path = validateArtifactPath(value);
    if (retired.has(path)) throw new GeneratedArtifactError(codes.duplicatePath, { path });
    if (expected.has(path)) throw new GeneratedArtifactError(codes.expectedRetiredOverlap, { path });
    retired.add(path);
    return path;
  }).sort();
  return Object.freeze({ artifacts: Object.freeze(artifacts), retiredPaths: Object.freeze(retiredPaths) });
}
