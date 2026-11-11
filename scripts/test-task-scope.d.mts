export declare const createTestTaskScope: () => {
  run<T>(operation: () => T | Promise<T>): Promise<T>;
  drain(): Promise<unknown[]>;
};
