/** 测试结束等待不等于异步主体停止；先排空原任务，再回收其夹具。 */
export const createTestTaskScope = () => {
  const tasks = new Set();
  return {
    run(operation) {
      const task = Promise.resolve().then(operation);
      tasks.add(task);
      // 拒绝由drain完整报告，避免框架超时后产生未处理拒绝。
      void task.catch(() => {});
      return task;
    },
    async drain() {
      const errors = [];
      while (tasks.size > 0) {
        const pending = [...tasks];
        const settled = await Promise.allSettled(pending);
        for (const task of pending) tasks.delete(task);
        for (const result of settled) if (result.status === 'rejected') errors.push(result.reason);
      }
      return errors;
    },
  };
};
