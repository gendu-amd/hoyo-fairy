// vitest 全局桩：config.ts / subscriptions/store.ts 在模块初始化时会调用 GM_* 与 GM_info，
// 这里在任何测试模块导入前提供内存实现，使纯逻辑可在 node 环境下被测试。
const store: Record<string, string> = {};
const g = globalThis as any;
g.GM_getValue = (k: string, d: unknown) => (k in store ? store[k] : d);
g.GM_setValue = (k: string, v: string) => {
  store[k] = v;
};
g.GM_info = { script: { version: '0.0.5' } };
