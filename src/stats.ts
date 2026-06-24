// 拦截统计与屏蔽记录（纯计数 + 环形日志）。命中后通过注入的监听器通知 UI（更新角标 / 刷新面板），
// 自身不直接依赖 UI，避免环。拦截层（无 card）与 DOM 层共用。
import { CONFIG, scheduleSave } from './config';
import { log } from './logging';

export interface BlockedEntry {
  title: string;
  up: string;
  uid: string;
  bvid: string;
  link: string;
  src: string; // NET=网络拦截层（渲染前删项）/ DOM=兜底隐藏 / CMT=评论 / BL=拉黑
  reason: string;
  t: number;
}

// 本次会话屏蔽记录（最新在前，上限 300）。
export const blockedLog: BlockedEntry[] = [];

// 本次会话计数（live binding；面板与启动汇总读取，清零用 setSessionBlocked）。
export let sessionBlocked = 0;
export function setSessionBlocked(n: number): void {
  sessionBlocked = n;
}

// 按拦截原因聚合计数，供面板「分类」与启动汇总共用。
export function tallyLog(): Record<string, number> {
  const t: Record<string, number> = {};
  for (const b of blockedLog) t[b.reason] = (t[b.reason] || 0) + 1;
  return t;
}

export function logBlocked(reason: string, info: any, src?: string): void {
  blockedLog.unshift({
    title: (info && info.title) || '',
    up: (info && info.up) || '',
    uid: (info && info.uid) || '',
    bvid: (info && info.bvid) || '',
    link: (info && info.link) || '',
    src: src || 'DOM',
    reason,
    t: Date.now(),
  });
  if (blockedLog.length > 300) blockedLog.pop();
}

// 命中记账后的监听器（由 UI 注册：更新角标 + 面板打开时刷新计数）。
let onRecorded: () => void = () => {};
export function setStatsListener(fn: () => void): void {
  onRecorded = fn;
}

// 记账：计数 + 日志 + 通知 UI。拦截层（无 card）与 DOM 层共用。
export function recordBlock(reason: string, info: any, src?: string): void {
  logBlocked(reason, info, src);
  sessionBlocked++;
  CONFIG.blockedCount++;
  onRecorded();
  scheduleSave();
  log(`拦截🚫 ${reason} ${info && info.up ? info.up + ' · ' : ''}${(info && info.title) || '(无标题)'}`);
}
