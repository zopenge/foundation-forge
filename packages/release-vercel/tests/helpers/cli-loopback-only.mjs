import net from 'node:net';
import process from 'node:process';
if (process.env.FORGE_FIXTURE_UMASK === '022') {
  if (process.platform === 'win32') {
    // Windows 无 POSIX umask；仅这个明确命名的测试场景模拟 CLI 的进程级权限掩码读写。
    let current = 0o022;
    process.umask = value => { const before = current; if (value !== undefined) current = value; return before; };
  } else process.umask(0o022);
}

// 真实 CLI 只能连接本测试服务器；不修改归档、文件选择或上传实现，也不允许意外访问云端。
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof first === 'object' && first !== null ? first : { port: first, host: args[1] };
  if (options.host !== '127.0.0.1' || String(options.port) !== process.env.FORGE_FIXTURE_API_PORT || options.path) {
    throw new Error('FIXTURE_NON_LOOPBACK_CONNECTION');
  }
  return Reflect.apply(connect, this, args);
};
