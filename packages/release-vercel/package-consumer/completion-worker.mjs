import filesystem from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { URL, pathToFileURL } from 'node:url';
import process from 'node:process';
import { completionRpcTransport } from './completion-rpc.mjs';

const [apiUrl, cwd, endpoint, counter, mode, binary] = process.argv.slice(2);
if (!apiUrl?.startsWith('file:') || !cwd || !endpoint || !counter || !['publish', 'crash-publish-receipt', 'verify-retry', 'cli-verify-retry'].includes(mode))
  throw new Error('completion fixture arguments');
const { runRelease, ReleaseError } = await import(apiUrl);
const { Execution } = await import(new URL('./node/execution.js', apiUrl));
const transport = completionRpcTransport(endpoint, (code, details) => new ReleaseError(code, details));
const execute = Execution.prototype.run;
const createScript = `
const f=require('node:fs');const [counter,flag,global,...args]=process.argv.slice(1);
if(flag!=='--global-config'||!global)throw Error('private CLI config missing');
const project=JSON.parse(f.readFileSync('.vercel/project.json','utf8'));
if(JSON.parse(f.readFileSync(global+'/config.json','utf8')).currentTeam!==project.orgId)throw Error('CLI team');
const expected=['deploy','--prebuilt','--archive=tgz','--prod','--skip-domain','--no-wait','--json','--non-interactive','--project',project.projectId,'--scope',project.orgId];
if(JSON.stringify(args)!==JSON.stringify(expected))throw Error('CLI argv');
const marker=JSON.parse(f.readFileSync('.vercel/output/static/.well-known/forge-prebuilt.json','utf8'));
if(!/^[a-f0-9]{64}$/.test(marker.artifactSha256))throw Error('CLI marker');
const count=f.existsSync(counter)?Number(f.readFileSync(counter,'utf8')):0;f.writeFileSync(counter,String(count+1));
const name=count===0?'candidate':'candidate'+(count+1);
process.stdout.write(JSON.stringify({status:'ok',deployment:{id:'dpl_'+name,url:'https://'+name+'.vercel.app',target:'production'}}));`;
Execution.prototype.run = function (name, check, ...rest) {
  if (name === 'prebuilt-create') {
    const index = check.args?.indexOf('--global-config') ?? -1;
    if (index < 0) throw new Error('fixture creation argv missing');
    check = { ...check, command: process.execPath, args: ['-e', createScript, counter, ...check.args.slice(index)] };
  } else if (name === 'vercel-api' && mode === 'cli-verify-retry') {
    const index = check.args?.indexOf('api') ?? -1, path = check.args?.[index + 1];
    if (index < 0 || !path) throw new Error('fixture API argv missing');
    const script = `const {completionRpc}=await import(process.argv[1]);const result=await completionRpc(process.argv[2],'api',[process.argv[3]],AbortSignal.timeout(30000));if(!result.ok)throw Error(result.error.code);process.stdout.write(JSON.stringify(result.value));`;
    check = { ...check, command: process.execPath, args: ['--input-type=module', '-e', script, new URL('./completion-rpc.mjs', import.meta.url).href, endpoint, path] };
  }
  return execute.call(this, name, check, ...rest);
};
if (mode === 'crash-publish-receipt') {
  const open = filesystem.promises.open;
  filesystem.promises.open = async (path, ...args) => {
    if (typeof path === 'string' && basename(path) === '.latest-publish.json.next' && dirname(path) === resolve(cwd, '.tmp/release-slot')) process.exit(71);
    return open(path, ...args);
  };
  syncBuiltinESMExports();
}
if (mode === 'cli-verify-retry') {
  if (!binary) throw new Error('CLI fixture binary missing');
  // CLI fixture不配置versionAlias，因此其只读云边界仅使用原vercel-api与build-info通道。
  globalThis.fetch = async (url, options) => {
    const target = typeof url === 'string' ? url : url.url ?? url.href;
    const value = await transport.buildInfo(target, options?.signal);
    return new globalThis.Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  process.argv = [process.execPath, binary, 'verify', '--cwd', cwd, '--retry-completion'];
  await import(pathToFileURL(binary).href);
} else {
  const report = await runRelease({ command: mode === 'verify-retry' ? 'verify' : 'publish', cwd, transport,
    ...(mode === 'verify-retry' ? { retryCompletion: true } : {}) });
  process.stdout.write(JSON.stringify(report)); process.exitCode = report.ok ? 0 : 1;
}
