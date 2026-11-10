import { loadPackageVerification } from './package-verification.mjs';

export const planConsumerPackages = (model, packageNames) => {
  const byName = new Map(model.packages.map(value => [value.name, value]));
  const selected = new Set();
  const visit = name => {
    if (selected.has(name)) return;
    const value = byName.get(name);
    if (!value) throw new Error(`unknown workspace package: ${name}`);
    selected.add(name);
    for (const dependency of value.workspaceDependencies) visit(dependency);
    for (const dependency of value.verification?.consumerDependencies ?? []) visit(dependency);
  };
  for (const name of packageNames) visit(name);
  return { packages: model.packages.filter(({ name }) => selected.has(name)), smokePackageNames: new Set(packageNames) };
};

// 本地 tarball 与 registry 消费共用准备和闭包；测试依赖不进入发布目标或运行时 DAG。
export const prepareConsumerPackages = async (model, packageNames) => {
  const byName = new Map(model.packages.map(value => [value.name, value]));
  const pending = [...packageNames], prepared = new Set();
  while (pending.length) {
    const name = pending.shift();
    if (prepared.has(name)) continue;
    const value = byName.get(name);
    if (!value) throw new Error(`unknown workspace package: ${name}`);
    prepared.add(name);
    value.verification ??= await loadPackageVerification(value);
    pending.push(...value.workspaceDependencies, ...(value.verification.consumerDependencies ?? []));
  }
  return planConsumerPackages(model, packageNames);
};
