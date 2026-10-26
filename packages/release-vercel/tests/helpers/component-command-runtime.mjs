/** 组件测试仍实时读取 Git；变更与未知指令不得绕过受管执行。 */
export function readOnlyGit(args) {
  const command = args[0];
  return ['ls-files', 'ls-tree', 'rev-parse', 'diff', 'cat-file', 'ls-remote', 'merge-base', 'show-ref', 'grep'].includes(command ?? '')
    || command === 'branch' && args[1] === '--show-current'
    || command === 'config' && ['--get', '--get-regexp'].includes(args[1] ?? '');
}

/** 仅在测试子进程内安装；真实公共入口不变，push/fetch/应用命令保留原执行器。 */
export function installReadQueryComponentExecution(Execution) {
  const git = Execution.prototype.git, streamGit = Execution.prototype.streamGit;
  const receiver = value => new Execution(value.cwd, value.config, value.signal, []);
  Execution.prototype.git = function (args) { return git.call(readOnlyGit(args) ? receiver(this) : this, args); };
  Execution.prototype.streamGit = function (args, consume, exitCodes) {
    return streamGit.call(readOnlyGit(args) ? receiver(this) : this, args, consume, exitCodes);
  };
  return () => { Execution.prototype.git = git; Execution.prototype.streamGit = streamGit; };
}
