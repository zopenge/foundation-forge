# @openge/forge-release-vercel

## 0.2.0

### Minor Changes

- d387554: 增加显式受管中断封存命令 retire：独立记录宿主来源确认与后续开机证明，在保留原始失败和 UNKNOWN 的前提下精确释放旧运行锁，支持封存中断后重入和同槽续用。新运行在执行前保存宿主来源；普通 recover 不再反复推荐无法补齐的历史关闭证明，并明确报告发布回执是否存在。

## 0.1.1

### Patch Changes

- 4019959: 内部普通与流式 Git 调用通过单次配置让自动维护、垃圾回收留在前台，避免它们脱离原命令的生命周期；保留已有维护策略、仓库配置、命令时限和未知关闭门禁。真实 Git 配置与 Trace2 回归覆盖新旧 Git 的调用方式。
- a2075de: 冻结源码复核和已提交配置读取保留 Git 执行失败、超时、取消和进程关闭未知的首错，避免误报为源码变化或配置未提交；仅在 Git 正常确认路径缺失时报告配置未提交，原有源码变化检查和发布阻断保持生效。
- 8329dfe: 受管 ignore 校验允许 CRLF/LF 行尾差异，继续拒绝未提交规则、clean filter 掩盖的改动及外部 ignore 来源。预算观察支持安装中暂时悬空的内部链接，按实际组件顺序验证既有祖先和根身份并拒绝外部或循环链接；已具备关闭证明的运行可以通过正式恢复入口复用槽位。生命周期失败保留脱敏底层首错，不被后续持久化错误覆盖，未知关闭状态仍不自动放行。
- Updated dependencies [24b09bf]
  - @openge/forge-process-control-node@0.4.0

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
