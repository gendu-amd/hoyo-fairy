// 规则变更事件 seam（叶子模块，零依赖）。
// 用途：打断 dom ↔ rules / subscriptions 的循环依赖。rules / subscriptions 改完配置后只“发事件”，
// 由 DOM 层在启动时注册真正实现（重建规则 + 全页重扫 + 评论重扫），这样底层模块不再 import dom。
type RulesChangedHandler = () => void;

// 默认空实现：即便在 DOM 层注册之前被调用也安全（仅 no-op，不抛错）。
let handler: RulesChangedHandler = () => {};

export function setRulesChangedHandler(fn: RulesChangedHandler): void {
  handler = fn;
}

export function emitRulesChanged(): void {
  handler();
}
