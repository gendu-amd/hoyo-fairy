// 订阅解析（纯逻辑，无 GM / 无 CONFIG）：把订阅文本（JSON 或 uBlock 风格纯文本）解析为 { meta, rules }。

// 订阅可携带的黑名单维度（白名单/开关/统计一律不接受）；未知维度忽略（向前兼容）。
export const SUB_DIMS = ['uids', 'upNames', 'keywords', 'partitions', 'tags', 'upBio', 'bvids'] as const;
export type SubDim = (typeof SUB_DIMS)[number];
export type SubRules = Partial<Record<SubDim, string[]>>;

// 纯文本行前缀 → 维度；无前缀=关键词；未知前缀忽略。行匹配正则由前缀表派生（单一来源，避免两处重复）。
const SUB_LINE_PREFIX: Record<string, SubDim> = { uid: 'uids', up: 'upNames', kw: 'keywords', part: 'partitions', tag: 'tags', bio: 'upBio', bv: 'bvids' };
const SUB_PREFIX_RE = new RegExp('^(' + Object.keys(SUB_LINE_PREFIX).join('|') + ')\\s*:\\s*(.+)$', 'i');

// 清洗规则维度 → {dim: string[]}：未知维度忽略、去空去重、限量（防超大列表）。
// 上限按维度区分：Set 精确维度(uid/UP名/bv)查找 O(1)，可承载大名单；正则维度合并成单条正则，保守些。
const SUB_CAP: Partial<Record<SubDim, number>> = { uids: 50000, upNames: 50000, bvids: 50000 };
const SUB_CAP_DEFAULT = 5000;

// 迁移层：把旧 format 的对象升级到当前结构（v1=identity；将来重命名/改维度在此加 case，旧订阅不破）。
function migrateSub(obj: any): any {
  return obj || {};
}

export function sanitizeSubRules(rawRules: any): SubRules {
  const out: SubRules = {};
  for (const dim of SUB_DIMS) {
    const arr = rawRules && rawRules[dim];
    if (!Array.isArray(arr)) continue;
    const max = SUB_CAP[dim] || SUB_CAP_DEFAULT;
    const seen = new Set<string>();
    const clean: string[] = [];
    for (const x of arr) {
      if (typeof x !== 'string') continue;
      const v = x.trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      clean.push(v);
      if (clean.length >= max) break;
    }
    if (clean.length) out[dim] = clean;
  }
  return out;
}

export interface ParsedSub {
  meta: Record<string, any>;
  rules: SubRules;
}

// 解析订阅文本 → { meta, rules }；以 { 开头按 JSON，否则按 uBlock 风格纯文本行。
export function parseSubscription(text: string): ParsedSub {
  const t = (text || '').trim();
  if (!t) throw new Error('空内容');
  if (t[0] === '{') {
    const obj = migrateSub(JSON.parse(t));
    const meta = obj && obj.meta && typeof obj.meta === 'object' ? obj.meta : {};
    // 优先 rules；兼容把「导出的配置文件」直接当订阅（从 config.block 取黑名单维度）
    let rawRules = obj && obj.rules;
    if (!rawRules && obj && obj.config && obj.config.block) rawRules = obj.config.block;
    return { meta, rules: sanitizeSubRules(rawRules) };
  }
  const meta: Record<string, any> = {};
  const buckets: Record<string, string[]> = {};
  for (let line of t.split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    if (line[0] === '!') {
      const m = line.slice(1).match(/^\s*([a-zA-Z][\w-]*)\s*:\s*(.+)$/);
      if (m) meta[m[1]] = m[2].trim();
      continue; // 其余 ! 行=注释
    }
    line = line.replace(/\s+#.*$/, '').trim(); // 行内 # 注释（前有空白）
    if (!line) continue;
    const pm = !line.startsWith('/') && line.match(SUB_PREFIX_RE);
    const dim = pm ? SUB_LINE_PREFIX[pm[1].toLowerCase()] : 'keywords';
    const val = pm ? pm[2].trim() : line;
    (buckets[dim] = buckets[dim] || []).push(val);
  }
  return { meta, rules: sanitizeSubRules(buckets) };
}
