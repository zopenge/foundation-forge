# @openge/forge-release-vercel

## 0.1.0

### Minor Changes

- 5396af9: 新增显式 Git integration 发布工具，提供严格配置、固定候选 SHA、真实 Git 快进门禁、有界检查、生产部署与域名复核、并发锁及部分成功恢复报告。
- 47b1bd4: 使用 schema 2 显式区分工作区与受管提交输入，提供固定 Git checkout、冻结安装、全阶段锁、有界预算与真实进程关闭记录；新增精确收据选择、独立冻结验收和显式 recover，保留未知副作用及原始失败证据。

### Patch Changes

- 5495bc1: 完成首次注册与可信发布配置后，通过 next 流程发布带来源证明的 rc.1 候选，供消费方精确安装和验证。
- Updated dependencies [47b1bd4]
  - @openge/forge-process-control@0.3.0
  - @openge/forge-process-control-node@0.3.0
  - @openge/forge-command-runner@0.2.0
