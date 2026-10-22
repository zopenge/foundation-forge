// 将命令的诊断文本作为可断言结果捕获，避免旧 Node 测试运行器把非 ASCII
// stdout 与 V8 测试协议混合解析（nodejs/node#64706）。二进制协议仍原样传递。
export const captureReleaseOutput = (context) => {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  context.mock.method(process.stdout, 'write', (chunk, encoding, callback) => {
    if (typeof chunk !== 'string') return original(chunk, encoding, callback);
    chunks.push(chunk);
    const done = typeof encoding === 'function' ? encoding : callback;
    done?.();
    return true;
  });
  return () => chunks.join('');
};
