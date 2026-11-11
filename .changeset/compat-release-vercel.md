---
"@openge/forge-release-vercel": minor
---

移除旧 schema 2 运行状态的读取与历史校验豁免，仅接受同时绑定原宿主和历史清单的 schema 3 运行状态。配置、报告、收据、锚点与独立停止证明仍沿用各自当前的 schema，不随运行状态版本变化。

删除 `confirmOrigin` / `--confirm-origin` 及人工确认旧运行来源的退役路径，退役仅使用运行开始时记录的原宿主证据；不再接纳旧 command-gate/result 文件。当前 schema 3 的恢复、后续开机退役、未启动尝试的显式弃置、停止证明及幂等收尾保持。
