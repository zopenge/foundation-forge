import { spawn, type ChildProcess } from 'node:child_process';
import { frame, readFrame, validateLaunch, type ScopeKey } from './protocol.js';
import { createLinuxReaper } from './linux-subreaper.js';

const [platform, scopeId, binding, nonce, timeout] = process.argv.slice(2);
if (platform !== process.platform || !['win32', 'linux'].includes(platform) || !scopeId || !binding || !nonce || !process.send || !Number.isSafeInteger(Number(timeout)) || Number(timeout) <= 0) process.exit(125);
const key: ScopeKey = { scopeId, binding, nonce };
let incoming = 0, outgoing = 0, bound = false, started = false, exited = false, stopping = false;
let child: ChildProcess | undefined;
const reaper = platform === 'linux' ? await createLinuxReaper(() => !started || exited, Number(timeout)) : undefined;
let operations = Promise.resolve();
async function abandon(): Promise<void> {
  if (stopping) return; stopping = true;
  try { await reaper?.stop(); } finally { process.exit(125); }
}
function send(type: string, payload?: unknown, id?: number): void {
  if (!process.connected) { void abandon(); return; }
  process.send?.(frame(key, ++outgoing, type, payload, id), error => { if (error) void abandon(); });
}
async function drainOutput(): Promise<void> {
  await Promise.all([process.stdout, process.stderr].map(stream => new Promise<void>((accept, reject) => {
    stream.write('', error => { if (error) reject(error); else accept(); });
  })));
}
async function receive(value: unknown): Promise<void> {
  if (stopping) return;
  try {
    const message = readFrame(value, key, ++incoming);
    if (message.id === undefined) throw new Error('MISSING_ID');
    if (message.type === 'bind' && !bound && !started) { bound = true; send('response', { ok: true }, message.id); }
    else if (message.type === 'start' && bound && !started) {
      const request = message.payload; validateLaunch(request); started = true;
      // 独立隐藏的 Windows 作业不创建 libuv 的另一层隐式 Job；输出用 pipe 转发并在关闭前排空。
      child = spawn(request.command, [...(request.args ?? [])], { ...(request.cwd === undefined ? {} : { cwd: request.cwd }), env: { ...request.environment }, shell: false, detached: platform === 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.pipe(process.stdout, { end: false }); child.stderr?.pipe(process.stderr, { end: false });
      child.once('error', () => { if (!exited) { exited = true; send('direct-exit', { exitCode: 126, signal: null }); } });
      child.once('close', (exitCode, signal) => {
        if (!exited) { exited = true; void drainOutput().then(() => send('direct-exit', { exitCode, signal }), () => abandon()); }
      });
      send('response', { ok: true }, message.id);
    } else if (message.type === 'inspect' && reaper) {
      send('response', { ok: true, empty: reaper.empty() }, message.id);
    } else if (message.type === 'stop' && reaper) {
      send('response', { ok: true, empty: await reaper.stop() }, message.id);
    } else if (message.type === 'finish' && (exited || !started)) {
      stopping = true; process.send?.(frame(key, ++outgoing, 'response', { ok: true }, message.id), () => process.exit(0));
    } else throw new Error('STATE');
  } catch { await abandon(); }
}
process.on('message', value => { operations = operations.then(() => receive(value)).catch(() => abandon()); });
process.on('disconnect', () => { void abandon(); });
process.on('SIGTERM', () => { void abandon(); });
send('ready');
