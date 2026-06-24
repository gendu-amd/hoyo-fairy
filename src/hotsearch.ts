// 热搜词屏蔽：注入/移除一段 display:none 样式隐藏搜索面板里的热搜榜。
import { CONFIG } from './config';

const HOTSEARCH_SELECTORS = [
  '.trending',
  '.search-panel .trending-list',
  '.search-panel-popover .trending',
  '.bili-header [class*="trending"]',
  '.center-search-container [class*="trending"]',
  '.search-panel [class*="trending"]',
  '.history-panel [class*="trending"]',
];

export function applyHotSearchStyle(): void {
  let st = document.getElementById('bfb-hotsearch-style');
  if (CONFIG.hideHotSearch) {
    if (!st) {
      st = document.createElement('style');
      st.id = 'bfb-hotsearch-style';
      document.head.appendChild(st);
    }
    st.textContent = HOTSEARCH_SELECTORS.join(',') + '{display:none !important}';
  } else if (st) {
    st.remove();
  }
}
