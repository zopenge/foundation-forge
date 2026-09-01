# Foundation Forge 编码代理协作规范

## 能力边界

- 本仓库只接收领域中立、可独立版本化且至少有两个独立消费者的基础能力。
- 禁止引入 AI agent、游戏、房间、Lobby、匹配、业务流程、渲染或产品专用存储语义。
- Core contract 不得依赖 Provider；Provider 可以依赖 Core，但 Provider 之间不得互相依赖。
- 禁止循环依赖、隐式 fallback、运行时自动选择 Provider，以及在公开签名中泄漏第三方实现类型。
- `index.ts` 和公开入口只承担导出与极薄装配职责，协议解析、I/O 与状态流程必须放在职责明确的文件中。

## TypeScript 与文本

- 源码使用 NodeNext/ESM，相对 import/export 必须包含 `.js` 运行时后缀。
- 禁止使用 `as unknown as` 双重断言和诊断压制注释掩盖契约问题。
- 运行逻辑只产生结构化错误和诊断；用户可见产品文案由上层应用负责。
- 新增或修订的代码注释、架构文档和交付说明默认使用简体中文，并以 UTF-8 保存。
- 对外 README 和公开包 README 使用英文；`README.zh-CN.md` 与英文入口保持同一 contract。

## 依赖与发布

- 依赖必须固定精确版本；公共包只声明自身运行所需的直接依赖。
- 不得提交 npm token、认证 `.npmrc`、其他包管理器 lockfile 或本地打包产物。
- 未经维护者明确授权，不得提交、推送、创建标签或发布 npm 包。
- 版本变更必须附 Changeset；RC 发布到 `next`，稳定版发布到 `latest`。

## 验证

- 功能实现和缺陷修复采用测试先行；先观察目标测试失败，再实现最小满足契约的代码。
- 交付前运行 `pnpm check`，lint 必须为 0 error/0 warning，测试不得存在未处理错误或异步泄漏。
- 浏览器入口必须确认不引用 `node:*`、`ws` server 或 Node-only transport。
- 打包验证必须基于实际 tarball，且临时文件只能位于仓库内已忽略的 `.tmp/`。
- 修改中文文本后扫描 U+FFFD、连续半角问号和常见 mojibake 特征，确认文本可读。
