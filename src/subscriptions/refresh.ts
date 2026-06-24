// 订阅刷新（运行时，联网）：按 expires 拉取远程订阅文本 → 解析 → 写缓存；有变更则通过 events 触发重建+重扫。
import { CONFIG } from '../config';
import { VERSION } from '../constants';
import { toast } from '../ui/toast';
import { emitRulesChanged } from '../events';
import { loadSubStore, saveSubStore } from './store';
import { parseSubscription, SUB_DIMS } from './parse';

// 元数据大小写不敏感读取（JSON 用 camelCase，文本头可能用任意大小写）。
export function metaGet(meta: any, key: string): any {
  if (!meta) return undefined;
  if (meta[key] != null) return meta[key];
  const lk = key.toLowerCase();
  for (const k in meta) if (k.toLowerCase() === lk) return meta[k];
  return undefined;
}

export function cmpVer(a: string, b: string): number {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

const DAY_MS = 24 * 3600e3;
export function parseExpires(s: unknown): number {
  const m = String(s ?? '').trim().match(/^(\d+)\s*([hd])?/i);
  if (!m) return DAY_MS; // 默认 1 天
  const n = Math.max(1, parseInt(m[1], 10) || 1);
  return n * ((m[2] || 'd').toLowerCase() === 'h' ? 3600e3 : DAY_MS);
}

const SUB_MAX_LEN = 2 * 1024 * 1024; // 订阅文本硬上限 2MB：超大/恶意内容在解析前就拒，避免内存峰值/卡顿

function fetchSubText(url: string, cb: (text: string | null, err: string | null) => void): void {
  if (typeof GM_xmlhttpRequest !== 'function') return cb(null, '无 GM_xmlhttpRequest');
  GM_xmlhttpRequest({
    method: 'GET',
    url,
    timeout: 15000,
    onload: (r) => {
      if (!(r.status >= 200 && r.status < 300) || !r.responseText) return cb(null, 'HTTP ' + r.status);
      if (r.responseText.length > SUB_MAX_LEN) return cb(null, '订阅内容过大（>2MB）');
      cb(r.responseText, null);
    },
    onerror: () => cb(null, '网络错误'),
    ontimeout: () => cb(null, '超时'),
  });
}

// 拉取并解析一条订阅，写入缓存；cb(ok)。
export function syncSubscription(url: string, cb?: (ok: boolean) => void): void {
  fetchSubText(url, (text, err) => {
    const store = loadSubStore();
    const finish = (patch: any, ok: boolean) => {
      const prev = store[url] || {};
      if (ok) {
        store[url] = patch;
      } else if (prev.ok && prev.rules) {
        // 瞬时失败但此前已有可用规则：保留旧规则，只记错误，不把 ok 翻成 false
        // （否则 collectSubRules 会因 !ok 丢弃整份订阅规则，造成一次网络抖动后保护静默消失）。
        // 不更新 lastSync，使其在下次刷新时仍被判为 due，尽快重试。
        store[url] = Object.assign(prev, { error: patch.error, lastError: Date.now() });
      } else {
        store[url] = Object.assign(prev, patch); // 本就无可用规则：照常标记失败
      }
      saveSubStore(store);
      cb && cb(ok);
    };
    if (err || !text) return finish({ lastSync: Date.now(), ok: false, error: err || '空内容' }, false);
    try {
      const { meta, rules } = parseSubscription(text);
      const count = SUB_DIMS.reduce((n, d) => n + ((rules[d] && rules[d]!.length) || 0), 0);
      finish({ meta, rules, lastSync: Date.now(), ok: true, count, error: null }, true);
      const minV = metaGet(meta, 'minScriptVersion');
      if (minV && cmpVer(VERSION, minV) < 0) toast(`订阅「${metaGet(meta, 'title') || url}」建议脚本升级到 ≥ ${minV}（部分规则可能未识别）`);
    } catch (e) {
      finish({ lastSync: Date.now(), ok: false, error: '解析失败' }, false);
    }
  });
}

// 刷新启用中的订阅；force=true 忽略 expires 间隔。完成后若有变更则触发规则重建 + 重扫。
export function refreshSubscriptions(force: boolean, done?: (n: number) => void): void {
  const store = loadSubStore();
  // GC：清掉已不在订阅列表里的缓存条目（删订阅/恢复默认后残留），避免缓存 blob 随历史 URL 累积。
  const urls = new Set((CONFIG.subscriptions || []).map((s) => s && s.url).filter(Boolean));
  let pruned = false;
  for (const k of Object.keys(store)) {
    if (!urls.has(k)) {
      delete store[k];
      pruned = true;
    }
  }
  if (pruned) saveSubStore(store);
  const due = (CONFIG.subscriptions || []).filter((s) => {
    if (!s || !s.enabled || !s.url) return false;
    if (force) return true;
    const e = store[s.url];
    if (!e || !e.ok) return true;
    return Date.now() - (e.lastSync || 0) >= parseExpires(metaGet(e.meta, 'expires'));
  });
  if (!due.length) return done && done(0);
  let pending = due.length;
  let changed = 0;
  due.forEach((s) =>
    syncSubscription(s.url, (ok) => {
      if (ok) changed++;
      if (--pending === 0) {
        if (changed) emitRulesChanged();
        done && done(changed);
      }
    })
  );
}
