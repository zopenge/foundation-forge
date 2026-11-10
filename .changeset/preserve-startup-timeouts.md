---
"@openge/forge-release-vercel": patch
---

修复受管命令在授权前超时后仍尝试迟到授权、导致原始超时被 JOURNAL_FAILED / INACTIVE 覆盖的问题。保留真实停止证明、所有守卫和原有命令期限，并提供有界启动阶段、预算排队及扫描计时，帮助区分目标脚本执行与授权前等待。
