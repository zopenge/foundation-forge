import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProcessDescriptor, ProcessIdentity } from '@openge/forge-process-control';

const execute = promisify(execFile);
type Query = (script: string, signal: AbortSignal) => Promise<string>;
const invalid = () => new Error('FIXTURE_ANCESTRY_UNBOUND');
const validPid = (value: unknown): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;
const queryWindows: Query = async (script, signal) => {
  const result = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { signal, windowsHide: true, maxBuffer: 1_048_576, encoding: 'utf8' });
  if (result.stderr.trim()) throw new Error('FIXTURE_ANCESTRY_QUERY_STDERR');
  return result.stdout;
};
const snapshot = (value: unknown): Map<number, ProcessDescriptor> => {
  if (!Array.isArray(value)) throw invalid();
  const result = new Map<number, ProcessDescriptor>();
  for (const row of value) {
    if (!row || typeof row !== 'object' || !validPid(row.ProcessId) || result.has(row.ProcessId)
      || typeof row.CreationDate !== 'string' || !row.CreationDate.trim()
      || !Number.isSafeInteger(row.ParentProcessId) || row.ParentProcessId < 0 || row.ParentProcessId > 0xffffffff) throw invalid();
    result.set(row.ProcessId, { pid: row.ProcessId, parentPid: row.ParentProcessId, startToken: row.CreationDate });
  }
  return result;
};

/** 一个命令内完成自有祖先链发现和同集复核；每次CIM查询都带明确PID过滤，不枚举主机。 */
export async function captureWindowsFixtureAncestry(owner: ProcessIdentity, leafPid: number, options: {
  readonly signal?: AbortSignal; readonly query?: Query;
} = {}): Promise<ProcessIdentity[]> {
  if (!validPid(owner.pid) || !validPid(leafPid) || owner.pid === leafPid || !owner.startToken) throw invalid();
  const signal = options.signal ?? AbortSignal.timeout(10_000); signal.throwIfAborted();
  // 只有通过uint32校验的数值进入脚本；不读取命令行、路径、环境或无关进程。
  const script = `
$ErrorActionPreference='Stop'
function Read-FixtureRows([long[]]$ids) {
  if ($ids.Count -eq 0) { throw 'FIXTURE_ANCESTRY_UNBOUND' }
  Get-CimInstance Win32_Process -Filter (($ids | ForEach-Object { 'ProcessId='+$_ }) -join ' OR ') -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,CreationDate
}
$initial=@(Read-FixtureRows @(${owner.pid}))
if ($initial.Count -ne 1) { throw 'FIXTURE_ANCESTRY_UNBOUND' }
$cursor=${leafPid}; $seen=@{}
for ($depth=0; $depth -lt 32 -and $cursor -ne ${owner.pid}; $depth++) {
  if ($cursor -le 0 -or $cursor -gt 4294967295 -or $seen.ContainsKey($cursor)) { throw 'FIXTURE_ANCESTRY_UNBOUND' }
  $seen[$cursor]=$true; $row=@(Read-FixtureRows @($cursor))
  if ($row.Count -ne 1) { throw 'FIXTURE_ANCESTRY_UNBOUND' }
  $initial += $row; $cursor=[long]$row[0].ParentProcessId
}
if ($cursor -ne ${owner.pid}) { throw 'FIXTURE_ANCESTRY_UNBOUND' }
$current=@(Read-FixtureRows @($initial | ForEach-Object { [long]$_.ProcessId }))
@{initial=@($initial);current=@($current)} | ConvertTo-Json -Depth 4 -Compress
`;
  let output: string;
  try { output = await (options.query ?? queryWindows)(script, signal); }
  catch (error) { throw new Error('FIXTURE_ANCESTRY_QUERY_batch', { cause: error }); }
  signal.throwIfAborted();
  const value: unknown = JSON.parse(output);
  if (!value || typeof value !== 'object') throw invalid();
  const initial = snapshot(Reflect.get(value, 'initial')), current = snapshot(Reflect.get(value, 'current'));
  if (initial.get(owner.pid)?.startToken !== owner.startToken || current.size !== initial.size) throw invalid();
  const chain: ProcessIdentity[] = [], seen = new Set<number>(); let cursor = leafPid;
  while (cursor !== owner.pid && chain.length < 32) {
    if (seen.has(cursor)) throw invalid(); seen.add(cursor);
    const row = initial.get(cursor);
    if (!row || !validPid(row.parentPid)) throw invalid();
    chain.push({ pid: row.pid, startToken: row.startToken }); cursor = row.parentPid;
  }
  if (cursor !== owner.pid || initial.size !== chain.length + 1) throw invalid();
  for (const [pid, row] of initial) {
    const fresh = current.get(pid);
    if (fresh?.startToken !== row.startToken || (pid !== owner.pid && fresh.parentPid !== row.parentPid)) throw invalid();
  }
  signal.throwIfAborted(); return chain;
}
