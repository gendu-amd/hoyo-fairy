// 开放 Shadow Root 注册表：部分卡片/评论渲染在 shadow DOM 内，普通 querySelectorAll 选不中。
// 启动全量采集一次，之后只在 MutationObserver 新增节点子树里增量采集，避免每次扫描全量遍历。
export const shadowRoots = new Set<ShadowRoot>();

export function harvestShadowRoots(root: Document | ShadowRoot | Element | null): void {
  if (!root || !root.querySelectorAll) return;
  try {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot && el.id !== 'bfb-overlay-host' && !shadowRoots.has(el.shadowRoot)) {
        shadowRoots.add(el.shadowRoot);
      }
    }
  } catch (e) {
    /* 选择器/遍历异常忽略 */
  }
}
