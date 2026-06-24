// 订阅缓存存取 + 汇总（数据层）：把拉取到的订阅规则缓存于 GM（不进 config、不外传），
// 并把所有【启用】订阅的规则汇总成 {dim: string[]} 供 buildMatchers 并入黑名单。
import { SUB_STORE_KEY } from '../constants';
import { CONFIG } from '../config';
import { SUB_DIMS, type SubRules } from './parse';

// 单条订阅缓存项。
export interface SubStoreEntry {
  meta?: Record<string, any>;
  rules?: SubRules;
  lastSync?: number;
  ok?: boolean;
  count?: number;
  error?: string | null;
}
export type SubStore = Record<string, SubStoreEntry>;

export function loadSubStore(): SubStore {
  try {
    return JSON.parse(GM_getValue(SUB_STORE_KEY, '') || '{}') || {};
  } catch (e) {
    return {};
  }
}

export function saveSubStore(store: SubStore): void {
  try {
    GM_setValue(SUB_STORE_KEY, JSON.stringify(store));
  } catch (e) {
    /* 存储不可用时静默 */
  }
}

// 汇总所有【启用】订阅的规则 → {dim: string[]}，供 buildMatchers 并入黑名单。
export function collectSubRules(): SubRules {
  const store = loadSubStore();
  const merged: SubRules = {};
  for (const sub of CONFIG.subscriptions || []) {
    if (!sub || !sub.enabled || !sub.url) continue;
    const e = store[sub.url];
    if (!e || !e.ok || !e.rules) continue;
    for (const dim of SUB_DIMS) {
      const arr = e.rules[dim];
      if (Array.isArray(arr) && arr.length) (merged[dim] = merged[dim] || []).push(...arr);
    }
  }
  return merged;
}
