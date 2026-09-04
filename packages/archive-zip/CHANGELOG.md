# @openge/forge-archive-zip

## 0.1.1-rc.0

- 精确依赖使用新版路径规则的 Archive Safety。
- 保留 UTF-8 文件名前导 BOM，并复用已验证的中央目录路径逐项解码，避免合法文件名别名和配置归档往返失败。

## 0.1.0

### Minor Changes

- 90357aa: Add domain-neutral archive, streaming protocol, workspace graph, and process control capabilities with explicit Providers. Process control includes process inspection and separate single-process and process-tree termination, while pnpm workspace discovery handles nested containers and overlapping patterns.

## 0.1.0-rc.1

### Minor Changes

- Publish the first Trusted Publishing release candidate after registry bootstrap.

## 0.1.0-rc.0

### Minor Changes

- Add deterministic ZIP32 encoding, bounded inspection, and safe in-memory decoding.
