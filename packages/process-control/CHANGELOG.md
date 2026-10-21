# @openge/forge-process-control

## 0.2.0

### Minor Changes

- b3db184: 新增独立的 ProcessIdentityReader 窄契约及显式 Windows/POSIX 工厂，仅读取指定 PID 和启动标识。Windows 通过 .NET Process/Console 读取真实创建时间并保留既有 CIM JSON-date token，POSIX 沿用 ps；命令无法启动、权限失败、身份无法确认或无效启动标识均以结构化错误拒绝，不将不确定状态视为进程不存在；完整进程查询与终止接口保持原有行为。

## 0.1.0

### Minor Changes

- 90357aa: Add domain-neutral archive, streaming protocol, workspace graph, and process control capabilities with explicit Providers. Process control includes process inspection and separate single-process and process-tree termination, while pnpm workspace discovery handles nested containers and overlapping patterns.

## 0.1.0-rc.2

### Minor Changes

- Add process descriptors, process enumeration, and explicit single-process termination contracts.

## 0.1.0-rc.1

### Minor Changes

- Publish the first Trusted Publishing release candidate after registry bootstrap.

## 0.1.0-rc.0

### Minor Changes

- Add provider-neutral process identity, listener selection, and termination contracts.
