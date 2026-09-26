const normalize = (value: string): string => value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '');

export const pathInScope = (path: string, scope: string): boolean => {
  const normalizedPath = normalize(path);
  const normalizedScope = normalize(scope);
  if (normalizedScope.length === 0) return true;
  return normalizedPath === normalizedScope || normalizedPath.startsWith(`${normalizedScope}/`);
};

export const scopesOverlap = (left: string, right: string): boolean => (
  pathInScope(normalize(left), right) || pathInScope(normalize(right), left)
);