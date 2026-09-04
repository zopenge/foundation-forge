# Repository Context

面向仓库工具维护者和公共基础能力消费者。本包从多个独立仓库工具共有的数据处理问题中抽取纯逻辑，不依赖具体消费者或业务拓扑。

## 输入与职责

消费者先完成文件发现、解析、语义分类和候选排序，再提供 profile、recipe、字符串数组及完整的依赖节点集合。registry 校验重复 ID、未知 profile、scope、非负整数限制和 recipe 数组结构；selection 按调用方顺序稳定去重后截断，required context 始终在前。

闭包只表达节点可达性，包含 root，允许环并保证终止，结果按 ID 排序。消费者的直接依赖、风险半径和分片策略不等同于闭包，不应为使用 API 而虚构依赖节点。

预算函数只计算百分比和结构化违规，不拥有质量阈值或 CLI 文案。比较函数仅处理文本映射，分别返回缺失、过期和多余路径，统一 CRLF、CR、LF，不执行 I/O。

## 依赖方向

本包只依赖更底层的 `@openge/forge-deterministic-json`，通过现有严格 JSON serializer 生成两空格缩进和末尾换行，不复制内部算法。依赖为有向无环图；公共入口仅聚合导出，所有运行时能力均可在浏览器入口使用。

## 消费者保留

recipe ID、子系统、风险等级、symbol tier、读取规则、解析器、tokenizer、schema、路径、query、telemetry、A/B 和 live benchmark 均归消费者。本包不提供自动 profile 回退，不过滤业务关键词，不自动选择 Provider。

## 验证

单元测试覆盖重复标识、无效输入、稳定顺序、先去重后截断、循环及未知依赖、预算边界、确定性 JSON 和换行比较。包级验证通过真实 tarball 安装并运行 consumer smoke，同时扫描浏览器公共入口的传递依赖。
