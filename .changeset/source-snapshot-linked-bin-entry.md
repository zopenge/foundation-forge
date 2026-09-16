---
"@openge/forge-source-snapshot": patch
---

修复 CLI 通过 pnpm/node_modules 链接路径执行时误判为非直接调用、从而静默 exit 0 且不执行命令的问题，并在真实 tarball consumer 中加入链接路径回归验证。
