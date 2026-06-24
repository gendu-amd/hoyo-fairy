// 页面模型与卡片选择器：识别当前页类型、定位“内层视频卡”与要隐藏的网格格子。
const IS_SEARCH = location.host === 'search.bilibili.com';
const IS_DYNAMIC = location.host === 't.bilibili.com';

export function pageType(): string {
  const h = location.href;
  if (IS_DYNAMIC) return '动态';
  if (h.includes('/v/popular/rank') || h.includes('/ranking')) return '排行榜';
  if (h.includes('/v/popular')) return '热门';
  if (IS_SEARCH) return '搜索页';
  if (/^https:\/\/www\.bilibili\.com\/?($|\?|#)/.test(h)) return '首页';
  if (h.includes('/video/')) return '播放页';
  return '其他';
}

// 「内层视频卡」选择器（兼容首页 / 热门 / 排行榜 / 搜索 / 播放页）。
export const VIDEO_CARD_SELECTOR = [
  'div.bili-video-card', // 首页 / 分区 / 搜索
  'div.video-page-card-small', // 播放页右侧推荐
  'li.bili-rank-list-video__item', // 分区右侧热门
  'div.video-card', // 综合热门 / 每周必看 / 入站必刷
  'li.rank-item', // 排行榜
  'div.video-card-reco',
  'div.video-card-common',
  'div.bili-dyn-list__item', // 动态信息流（t.bilibili.com）
  'div.floor-card.single-card', // 首页信息流里的「直播推荐」单卡（链向 live.bilibili.com）
].join(',');

// 定位要隐藏的网格格子：显式有序链，避免破坏布局。
export function cellOf(el: Element): Element {
  // 直播推荐卡：外层 .floor-single-card 是带宽高占位的容器，只隐内层会留黑框，故上移到它
  const fc = el.closest('div.feed-card, div.bili-feed-card, div.floor-single-card');
  if (fc) return fc;
  if (IS_SEARCH && el.parentElement && el.parentElement !== document.body) return el.parentElement;
  return el;
}
// 护栏：隐藏时别误删大容器/含多卡的元素（会连带删掉加载哨兵）。
export function isUnsafeHideTarget(el: Element | null): boolean {
  if (!el || el === document.body || el === document.documentElement) return true;
  if (el.matches && el.matches('.container, .feed2, .bili-feed4, #i_cecream, #app, .bili-header')) return true;
  try {
    if (el.querySelectorAll(VIDEO_CARD_SELECTOR).length > 1) return true;
  } catch (e) {
    /* 选择器异常忽略 */
  }
  return false;
}
