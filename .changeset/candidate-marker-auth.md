---
"@openge/forge-release-vercel": patch
---

为原生受管 prebuilt 候选 marker 增加可选的 `candidateMarkerAuth`。SDK 在 provider 核对候选身份和 READY 状态后惰性读取凭据，并在同一次调用内按精确 HTTPS origin 复用。凭据仅用于候选 marker GET，保留现有代理、无重定向、严格摘要校验及单次原生提升。
