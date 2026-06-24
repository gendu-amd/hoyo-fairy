// @ts-nocheck
// DOM 兜底层：处理网络拦截层覆盖不到的部分（首屏 SSR 漏网、需联网取数的进阶维度），命中即安全隐藏整张卡。
// 单卡处理有错误边界，异形卡不会中断整轮扫描。本层为 DOM 操作密集，暂保留 @ts-nocheck（渐进类型化）。
import { CONFIG } from './config';
import { ATTR_API, ATTR_BLOCKED, PROCESSED } from './constants';
import { cellOf, isUnsafeHideTarget, VIDEO_CARD_SELECTOR } from './page';
import { extractCardInfo } from './cardinfo';
import { M, matchRule, matchApi, apiNeeds, apiRulesActive, isWhitelisted, rebuildRules } from './match/engine';
import { fetchView, fetchTags, fetchCard } from './api';
import { recordBlock } from './stats';
import { shadowRoots } from './shadow';
import { scanComments } from './comments';
import { addToList } from './rules';
import { log, safe } from './logging';
import { toast } from './ui/toast';
import { refreshPanelIfOpen } from './ui/hooks';

const countedEls = new WeakSet(); // DOM 兜底「已计数」去重

// 撤销 DOM 层对某卡的隐藏 / 审查标记（规则变更后重扫时调用）。
function clearVisual(card) {
  card.style.display = '';
  card.classList.remove('bfb-review');
  const t = card.querySelector(':scope > .bfb-tag');
  if (t) t.remove();
  card.removeAttribute(ATTR_BLOCKED);
  const cell = cellOf(card);
  if (cell !== card) cell.style.display = '';
}

// 审查模式：不隐藏，给卡片打醒目标记 + 原因 + 就地「放行」按钮，便于核对防误伤。
function markCard(card, reason, info) {
  card.classList.add('bfb-review');
  if (card.querySelector(':scope > .bfb-tag')) return;
  const tag = document.createElement('div');
  tag.className = 'bfb-tag';
  const rs = document.createElement('span');
  rs.className = 'rs';
  rs.textContent = '已判定拦截 · ' + reason;
  tag.appendChild(rs);
  if (info.up || info.uid || info.bvid) {
    const pass = document.createElement('button');
    pass.textContent = '✅放行';
    pass.title = '误伤了？把该 UP 加白名单，永不再拦';
    pass.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (info.uid) addToList(CONFIG.allow.uids, info.uid);
      else if (info.up) addToList(CONFIG.allow.upNames, info.up);
      else if (info.bvid) addToList(CONFIG.allow.keywords, info.title || info.bvid);
      toast('已放行：' + (info.up || info.title || info.bvid));
      refreshPanelIfOpen();
    };
    tag.appendChild(pass);
  }
  card.appendChild(tag);
}

// DOM 兜底层：审查模式标记、否则直接隐藏漏网卡。主路径由网络拦截层在渲染前就删除。
export function blockVideo(card, reason, info) {
  if (CONFIG.reviewMode) {
    markCard(card, reason, info);
  } else {
    const cell = cellOf(card);
    if (!isUnsafeHideTarget(cell)) cell.style.display = 'none';
    card.style.display = 'none';
  }
  card.setAttribute(ATTR_BLOCKED, '1'); // 供「批量拉黑」扫描
  if (countedEls.has(card)) return;
  countedEls.add(card);
  recordBlock(reason, info, 'DOM');
}

// 单卡处理用错误边界包裹：异形卡导致 extractCardInfo/matchRule 抛错时，只跳过这一张、不中断整轮扫描。
export const processCard = safe('processCard', function (card) {
  if (!CONFIG.enabled) return;
  if (card.getAttribute(PROCESSED)) return;
  const info = extractCardInfo(card, M.needUid); // 无 UID 规则时跳过昂贵的 innerHTML 兜底
  if (!info.title && !info.up && !info.isLive) return; // 骨架卡，等填充后再处理（直播卡常无标题，放行交给规则判定）
  card.setAttribute(PROCESSED, '1');
  card._bfbInfo = info;
  const hit = matchRule(info);
  if (!hit) log(`放行✅ | 标题:${info.title || '(无)'} | UP:${info.up || '(无)'} | 标签:${info.partition || '(无)'}`);
  if (hit) {
    blockVideo(card, hit, info);
    return;
  }
  // 过了本地规则、未命中白名单、且开了精确过滤 → 按需取数再判（限速、缓存）
  if (info.bvid && apiRulesActive()) evaluateApi(card, info);
});

// 异步评估：只取需要的接口，命中则隐藏/标记（与本地规则同一套出口 blockVideo）。
function evaluateApi(card, info) {
  if (card.getAttribute(ATTR_API)) return;
  card.setAttribute(ATTR_API, '1');
  const need = apiNeeds();
  let view = null;
  let tags = null;
  let cardData = null;
  let pending = 1; // 守卫位：占位到所有同步派发完成再释放，避免缓存命中的同步回调导致 pending 中途归零、提前 finish
  const finish = () => {
    if (pending > 0) return;
    if (!CONFIG.enabled || isWhitelisted(info)) return;
    const hit = matchApi(info, view, tags, cardData);
    if (hit) blockVideo(card, hit, info);
    else log(`API放行 | ${info.title || ''}`);
  };
  const afterView = () => {
    // UP 卡片需要 mid：优先用 DOM 解析到的，没有就用 view.owner.mid
    if (need.needCard) {
      const mid = info.uid || (view && view.owner && view.owner.mid);
      if (mid) {
        pending++;
        fetchCard(mid, (c) => {
          cardData = c;
          pending--;
          finish();
        });
      }
    }
    finish();
  };
  if (need.needView) {
    pending++;
    fetchView(info.bvid, (v) => {
      view = v;
      pending--;
      afterView();
    });
  }
  if (need.needTag) {
    pending++;
    fetchTags(info.bvid, (t) => {
      tags = t;
      pending--;
      finish();
    });
  }
  pending--; // 释放守卫：同步派发已结束；若此刻请求都已（同步）完成则在此真正评估一次
  finish();
}

// 普通 DOM 卡片 ∪ 各存活 shadow root 内的卡片。
export function queryCards() {
  const out = Array.from(document.querySelectorAll(VIDEO_CARD_SELECTOR));
  for (const r of shadowRoots) {
    if (!r.host || !r.host.isConnected) {
      shadowRoots.delete(r);
      continue;
    }
    try {
      const found = r.querySelectorAll(VIDEO_CARD_SELECTOR);
      if (found.length) out.push(...found);
    } catch (e) {}
  }
  return out;
}

export function scanAll() {
  if (!CONFIG.enabled) return;
  queryCards().forEach((card) => {
    if (card.getAttribute(PROCESSED)) return;
    if (card.closest && card.closest('.recommended-swipe')) return; // 顶部轮播 banner，跳过
    processCard(card);
  });
}

export function rescanAfterRuleChange() {
  rebuildRules();
  document.querySelectorAll('[' + PROCESSED + ']').forEach((el) => {
    el.removeAttribute(PROCESSED);
    el.removeAttribute(ATTR_API);
    clearVisual(el);
  });
  scanAll();
  scanComments(); // ruleVersion 已自增，评论会按新规则重判
}
