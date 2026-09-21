---
'@openge/forge-repository-context': patch
---

大型 TypeScript 仓库构建索引时改为迭代追加抽取结果，避免超过 JavaScript 函数参数上限；宽 scope 同时跳过 `dist` 与 `coverage` 等常规派生输出。
