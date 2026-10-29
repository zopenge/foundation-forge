# @openge/forge-process-control-node

## 0.5.0

### Minor Changes

- 7949fbe: 新增显式 Windows 原生进程身份读取器，使用受限进程句柄绑定 PID、创建时间与存活状态，避免逐次启动查询进程；保持取消、身份校验、结构化错误及句柄关闭约束，不引入自动回退。

## 0.4.0

### Minor Changes

- 24b09bf: Windows 自有 Job 在直接命令退出后允许有界自然收尾，持续持有已确认归属的成员实例句柄，并以最终 Job 空集合证明正常关闭。自然收尾最多使用一秒且不超过既有终止预算的一半，剩余关闭阶段共用原截止时间；强制终止可打断已开始的正常收尾，取消、超时、未知身份及强制清理永不升级为正常完成。此变更替代此前发现存活后代立即失败的行为，不按进程名称豁免 console 或其他后代。

## 0.3.0

### Minor Changes

- 47b1bd4: Add explicit OS-owned command scopes, bounded Windows Job and Linux subreaper Providers, and a runner manual authorization gate with durable closure evidence.

### Patch Changes

- Updated dependencies [47b1bd4]
  - @openge/forge-process-control@0.3.0

## 0.2.0

### Minor Changes

- b3db184: 新增独立的 ProcessIdentityReader 窄契约及显式 Windows/POSIX 工厂，仅读取指定 PID 和启动标识。Windows 通过 .NET Process/Console 读取真实创建时间并保留既有 CIM JSON-date token，POSIX 沿用 ps；命令无法启动、权限失败、身份无法确认或无效启动标识均以结构化错误拒绝，不将不确定状态视为进程不存在；完整进程查询与终止接口保持原有行为。

### Patch Changes

- Updated dependencies [b3db184]
  - @openge/forge-process-control@0.2.0

## 0.1.0

### Minor Changes

- 90357aa: Add domain-neutral archive, streaming protocol, workspace graph, and process control capabilities with explicit Providers. Process control includes process inspection and separate single-process and process-tree termination, while pnpm workspace discovery handles nested containers and overlapping patterns.

### Patch Changes

- Updated dependencies [90357aa]
  - @openge/forge-process-control@0.1.0

## 0.1.0-rc.2

### Minor Changes

- Add Windows and Posix process enumeration and explicit single-process termination.

## 0.1.0-rc.1

### Minor Changes

- Publish the first Trusted Publishing release candidate after registry bootstrap.

## 0.1.0-rc.0

### Minor Changes

- Add explicit Windows and Posix process discovery and termination providers.
