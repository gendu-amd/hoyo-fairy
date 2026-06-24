// UI 回调注入桥：低层模块（stats / dom / blacklist / subscriptions）经此回调到设置面板，
// 避免直接 import 面板模块造成循环依赖。main 在启动时用 setPanelHooks 注册真正实现。
type Action = () => void;

let _refreshPanelIfOpen: Action = () => {};
let _openPanel: Action = () => {};

export function setPanelHooks(h: { refreshPanelIfOpen?: Action; openPanel?: Action }): void {
  if (h.refreshPanelIfOpen) _refreshPanelIfOpen = h.refreshPanelIfOpen;
  if (h.openPanel) _openPanel = h.openPanel;
}

export function refreshPanelIfOpen(): void {
  _refreshPanelIfOpen();
}
export function openPanel(): void {
  _openPanel();
}
