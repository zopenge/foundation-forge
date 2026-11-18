import filesystem from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { URL, pathToFileURL } from 'node:url';
import process from 'node:process';
import { mock } from 'node:test';
import { completionRpcTransport } from './completion-rpc.mjs';

const [apiUrl, cwd, endpoint, counter, mode, binary] = process.argv.slice(2);
if (!apiUrl?.startsWith('file:') || !cwd || !endpoint || !counter || !['publish', 'crash-publish-receipt', 'verify-retry', 'cli-verify-retry', 'cli-status'].includes(mode))
  throw new Error('completion fixture arguments');
const transport = completionRpcTransport(endpoint, (code, details) => new ReleaseError(code, details));
const cli = mode === 'cli-verify-retry' || mode === 'cli-status';
if (cli) {
  const { request } = await import('node:http');
  // 仅将固定云地址转至自有真实HTTP服务；保留SDK的认证、计时、限长及request/socket关闭。
  mock.module('node:https', { namedExports: { request: (url, options, callback) => {
    if (url.origin !== 'https://api.vercel.com' || options.method !== 'GET') throw new Error('unexpected native fixture request');
    return request(new URL(`${url.pathname}${url.search}`, endpoint), options, callback);
  } } });
  // 仅替换公开HTTP适配叶边界；真实CLI、限长读取、解析及发布/恢复流程仍执行安装产物。
  mock.module('@openge/forge-http-transport/node', { namedExports: {
    createNodeHttpTransport: () => ({
      fetch: async (input, options) => {
        const target = typeof input === 'string' ? input : input.url ?? input.href;
        const value = await transport.buildInfo(target, options?.signal);
        return new globalThis.Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
      },
      describeRoute: () => ({ route: 'direct', bypassed: false }),
      close: async () => {},
    }),
  } });
}
const { runRelease, ReleaseError } = await import(apiUrl);
const { Execution } = await import(new URL('./node/execution.js', apiUrl));
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
  } else if (name === 'vercel-api' && cli) {
    throw new Error('default prebuilt reads must use the native fixture endpoint');
  }
  return execute.call(this, name, check, ...rest);
};
if (mode === 'crash-publish-receipt') {
  const open = filesystem.promises.open;
  filesystem.promises.open = async (path, ...args) => {
    if (typeof path === 'string' && basename(path) === '.latest-publish.json.next' && dirname(path) === resolve(cwd, 'state/release-slot')) process.exit(71);
    return open(path, ...args);
  };
  syncBuiltinESMExports();
}
if (cli) {
  if (!binary) throw new Error('CLI fixture binary missing');
  // CLI fixture不配置versionAlias，只读云边界沿受控RPC，未替换全局fetch。
  process.argv = [process.execPath, binary, ...(mode === 'cli-status' ? ['status', '--cwd', cwd] : ['verify', '--cwd', cwd, '--retry-completion'])];
  await import(pathToFileURL(binary).href);
} else {
  const report = await runRelease({ command: mode === 'verify-retry' ? 'verify' : 'publish', cwd, transport,
    ...(mode === 'verify-retry' ? { retryCompletion: true } : {}) });
  process.stdout.write(JSON.stringify(report)); process.exitCode = report.ok ? 0 : 1;
}
