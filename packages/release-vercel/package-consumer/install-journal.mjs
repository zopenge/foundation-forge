import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

// 安装生命周期只读取本次 checkout 的真实日记，不创建或补造停止凭证。
const state = JSON.parse(await readFile(resolve(process.cwd(), '../state.json'), 'utf8'));
const command = state.processes.at(-1);
if (command?.name !== 'install' || command.kind !== undefined || command.status !== 'identified'
  || !Number.isSafeInteger(command.identity?.pid) || command.identity.pid <= 0 || !command.identity.startToken
  || !command.scope?.scopeId || !command.scope.binding)
  throw new Error('pnpm install started before its real identity journal was persisted');
process.stdout.write('INSTALL_JOURNAL_VERIFIED\n');
