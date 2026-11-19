---
"@openge/forge-process-control-node": minor
"@openge/forge-release-vercel": patch
---

公开 `acquireLocalDirectoryLease`，在 Windows x64 和 Linux/glibc x64 上按规范化目录身份持有本机互斥。`forge-release-vercel` 的恢复与退役共用该实现并保留原锁绑定，进程停止证据和远端写入所有权仍独立核验。
