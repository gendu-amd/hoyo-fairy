// 卡片信息抽取：从 DOM 卡片（extractCardInfo）或接口 JSON 列表项（normFeedItem）
// 归一成同形状的 CardInfo，供匹配引擎判定。两路同构，判定一致。
// 广告/直播检测是热路径开销，仅在对应功能开启时才做——开关经 configureCardDetect 注入，避免直接耦合 CONFIG。
import { parseDuration, parseCount } from './util';

// 归一后的卡片信息：DOM 抽取与接口归一两路同构。
export interface CardInfo {
  title: string;
  up: string;
  uid: string;
  partition: string;
  bvid: string;
  link?: string;
  duration: number | null;
  views: number | null;
  likes: number | null;
  isLive: boolean;
  isAd: boolean;
}

interface DetectFlags {
  detectAd: boolean;
  detectLive: boolean;
}
// 默认不检测（零开销）；主程序在 CONFIG 就绪后注入 () => ({ detectAd: hideAd, detectLive: hideLiveCard }）。
let getDetect: () => DetectFlags = () => ({ detectAd: false, detectLive: false });
export function configureCardDetect(fn: () => DetectFlags): void {
  getDetect = fn;
}

function pickText(card: Element, selectors: string[]): string {
  for (const sel of selectors) {
    const el = card.querySelector(sel);
    if (el) {
      const v = el.getAttribute('title') || el.textContent;
      if (v && v.trim()) return v.trim();
    }
  }
  return '';
}

// deepUid: 是否为缺 UID 的卡做昂贵的 innerHTML 兜底解析（扫描热路径按需，拉黑场景强制 true）。
export function extractCardInfo(card: Element, deepUid = true): CardInfo {
  const info: CardInfo = { title: '', up: '', uid: '', partition: '', bvid: '', duration: null, views: null, likes: null, isLive: false, isAd: false };

  info.title = pickText(card, [
    '.bili-video-card__info--tit',
    '.video-name',
    'h3[title]',
    '.title',
    '.bili-dyn-card-video__title', // 动态内视频标题
    '.dyn-card-opus__title', // 动态专栏/图文标题
    '.bili-dyn-content__orig__desc', // 动态正文（文字动态，便于关键词命中）
  ]);
  info.up = pickText(card, [
    '.bili-video-card__info--author',
    '.up-name__text',
    '.up-name',
    '.bili-video-card__info--owner span',
    '.upname .name',
    '.bili-dyn-title__text', // 动态发布者
  ]);

  // UID（拉黑必需）：space 链接 → data-* → innerHTML 兜底（含纯文本卡内嵌的 "mid":数字）
  const upA = card.querySelector('a[href*="space.bilibili.com"]');
  if (upA) info.uid = ((upA.getAttribute('href') || '').match(/space\.bilibili\.com\/(\d+)/) || [])[1] || '';
  if (!info.uid) {
    const midEl = card.querySelector('[data-mid],[data-up-mid],[data-user-id]');
    if (midEl) info.uid = midEl.getAttribute('data-mid') || midEl.getAttribute('data-up-mid') || midEl.getAttribute('data-user-id') || '';
  }
  // innerHTML 兜底会序列化整张卡 HTML，开销较大：仅在需要 UID（存在 UID 规则或拉黑场景）且 DOM 没抠到时才走
  if (!info.uid && deepUid) {
    info.uid = (card.innerHTML.match(/space\.bilibili\.com\/(\d+)/) || [])[1] || '';
    if (!info.uid) info.uid = (card.innerHTML.match(/"(?:mid|owner_?id|up_?mid)"\s*:\s*"?(\d{2,})"?/) || [])[1] || '';
  }

  info.partition = pickText(card, ['.bili-video-card__info--tag', '.rcmd-tag']);

  const aVideo = card.querySelector('a[href*="/video/"]');
  if (aVideo) {
    const m = (aVideo.getAttribute('href') || '').match(/(BV[0-9A-Za-z]+)/);
    if (m) info.bvid = m[1];
  }

  info.duration = parseDuration(pickText(card, ['.bili-video-card__stats__duration', '.duration', '.bili-dyn-card-video__duration']));

  const statEl = card.querySelector('.bili-video-card__stats--item') || card.querySelector('.play-text');
  if (statEl) info.views = parseCount(statEl.textContent);

  const { detectAd, detectLive } = getDetect();
  // 直播识别：服务于「屏蔽直播推荐卡」，并避免把直播误当广告。hideAd / hideLiveCard 任一开启才算（省热路径）。
  if (detectAd || detectLive) {
    info.isLive = !!(
      card.querySelector('a[href*="live.bilibili.com"]') ||
      card.querySelector('.bili-live-card, [class*="live-card"]') ||
      /直播中|正在直播/.test(card.textContent || '')
    );
  }

  // 广告判定（含遍历全卡 span/div 找角标文案）只服务于「屏蔽广告卡」，hideAd 关时整段跳过，省热路径开销。
  if (detectAd) {
    const adBadge = Array.from(card.querySelectorAll('span,div')).some((el) => {
      const tx = (el.textContent || '').trim();
      return tx === '广告' || tx === '赞助' || tx === '推广';
    });
    // 仅用稳定的广告标识判定：官方广告类名 / 投流域名 / 运营推广链接 / 显式角标文案。
    info.isAd = !info.isLive && !!(
      card.querySelector('.bili-video-card__info--ad') ||
      card.querySelector('a[href*="cm.bilibili.com"]') ||
      card.querySelector('a[href*="//mall.bilibili.com"]') ||
      card.querySelector('a[href*="specialRecommendByOp"]') ||
      adBadge
    );
  }

  return info;
}

// 各接口的「列表项」归一成与 extractCardInfo 同形状的 info（rcmd/ranking/popular/related 同构）。
// it 为各推荐接口的原始 JSON 列表项，字段形态各异，统一以宽松类型读取后归一。
export function normFeedItem(it: any): CardInfo | null {
  if (!it || typeof it !== 'object') return null;
  const goto = it.goto || it.card_goto || '';
  const owner = it.owner || {};
  const stat = it.stat || {};
  // 广告项标题/落地页常埋在 ad_info / cm 里，尽量抠出来，便于在屏蔽记录里辨识
  const ad = it.ad_info || it.cm_info || it.cm || null;
  const adC = (ad && (ad.creative_content || ad.creative)) || {};
  // 搜索结果的 title 内含 <em class="keyword"> 高亮标签，去标签后再匹配（其它接口无标签，无副作用）
  const rawTitle = it.title || adC.title || adC.description || ad?.title || '';
  return {
    title: String(rawTitle || '').replace(/<[^>]*>/g, ''), // String()：接口偶发非字符串 title 时不抛错
    up: owner.name || it.author || it.name || (ad && ad.source_content && ad.source_content.name) || '',
    uid: owner.mid != null ? String(owner.mid) : it.mid != null ? String(it.mid) : '',
    partition: it.tname || it.typename || (it.rcmd_reason && it.rcmd_reason.content) || '',
    bvid: it.bvid || '',
    link: it.uri || it.jump_url || adC.url || adC.jump_url || '',
    duration: typeof it.duration === 'number' ? it.duration : it.duration ? parseDuration(it.duration) : null,
    views: stat.view != null ? stat.view : stat.play != null ? stat.play : it.play != null ? it.play : null,
    likes: stat.like != null ? stat.like : null, // 点赞数（feed JSON 才有；用于营销号低赞率识别）
    isLive: goto === 'live',
    isAd: goto === 'ad' || goto === 'cm' || !!it.ad_info || !!it.is_ad,
  };
}
