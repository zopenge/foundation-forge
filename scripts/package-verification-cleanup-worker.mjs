import { rmSync } from 'node:fs';
import { assertPackageVerificationIdentity } from './package-verification-cleanup.mjs';

const value = JSON.parse(process.argv[2]);
await assertPackageVerificationIdentity(value);
// 主 context 保持异步监督与取消；仅该受管子进程同步遍历大安装树。
rmSync(value.directory, { recursive: true, force: true });
