export const selectCheckMode = (previous, current, packages) => {
  if (previous?.schemaVersion !== 1 || current?.schemaVersion !== 1
    || previous.environmentDigest !== current.environmentDigest
    || previous.files == null || current.files == null) return { kind: 'full' };

  const before = previous.files;
  const after = current.files;
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path]);
  if (changed.length === 0) return { kind: 'cached' };
  if (changed.some((path) => !(path in after) || after[path] === null)) return { kind: 'full' };

  const documentation = (path) => path === 'README.md'
    || (path.startsWith('docs/') && path.endsWith('.md'))
    || /^\.changeset\/[^/]+\.md$/u.test(path);
  const packageChanges = changed.filter((path) => !documentation(path));
  if (packageChanges.length === 0) return { kind: 'docs' };
  const unpublishedEvaluationInput = (path) => packages.some(({ directory, manifest }) => {
    if (!path.startsWith(`${directory}/evaluation/`) || !path.endsWith('.mjs')) return false;
    const published = manifest?.files;
    return Array.isArray(published) && published.length > 0
      && published.every((entry) => {
        if (typeof entry !== 'string' || /[?*{}!]/u.test(entry)
          || entry.includes('[') || entry.includes(']')) return false;
        const included = entry.replaceAll('\\', '/')
          .replace(/^(?:\.\/)+/u, '').replace(/\/+$/u, '');
        return included.length > 0 && included !== '.'
          && !included.split('/').includes('..')
          && included !== 'evaluation' && !included.startsWith('evaluation/');
      });
  });
  const scriptTestInput = (path) => path.startsWith('scripts/tests/')
    || path === 'scripts/ab-eval.mjs' || path.startsWith('scripts/ab-eval/')
    || unpublishedEvaluationInput(path);
  if (packageChanges.every(scriptTestInput))
    return { kind: 'script-tests' };

  const affected = new Set();
  const runtimeAffected = new Set();
  for (const path of packageChanges) {
    const owner = packages.find(({ directory }) => path.startsWith(`${directory}/src/`)
      || path.startsWith(`${directory}/tests/`) || path === `${directory}/README.md`);
    if (!owner) return { kind: 'full' };
    affected.add(owner.name);
    if (path.startsWith(`${owner.directory}/src/`)) runtimeAffected.add(owner.name);
  }
  let grew;
  do {
    grew = false;
    for (const { name, workspaceDependencies } of packages) {
      if (runtimeAffected.has(name)
        || !workspaceDependencies.some((dependency) => runtimeAffected.has(dependency))) continue;
      runtimeAffected.add(name);
      grew = true;
    }
  } while (grew);
  for (const name of runtimeAffected) affected.add(name);
  const packageNames = packages.filter(({ name }) => affected.has(name)).map(({ name }) => name);
  if (packageNames.length === packages.length) return { kind: 'full' };
  if (packageNames.length === 1) return { kind: 'leaf', packageName: packageNames[0] };
  return { kind: 'packages', packageNames };
};
