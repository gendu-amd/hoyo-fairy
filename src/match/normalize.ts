// 匹配核心：文本归一 + 规则行编译 + 作用域关键词 + 输入拆分。纯逻辑，无 DOM / 无网络依赖（L0 叶子）。
// 唯一的运行时配置依赖（fuzzyMatch 开关）通过 configureFuzzy 注入，便于单测与解耦。

export const lc = (s: unknown): string => (s || '').toString().trim().toLowerCase();

// 全角→半角归一（含全角空格 U+3000），防止用全角字符绕过关键词。
export function toHalfWidth(s: unknown): string {
  return (s || '')
    .toString()
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// —— 反绕过归一 ——
// 隐形字符(零宽空格/方向控制符等)：纯绕过手段、零误伤，始终剔除。
const INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;
export const stripInvisible = (s: unknown): string => (s || '').toString().replace(INVISIBLE_RE, '');

// 分隔符：fuzzyMatch 开启时从文本与普通词两侧一并剔除，使“原 神 / 原.神 / 原·神”也命中。
// 只跨分隔符桥接、不跨文字，故几乎不误伤（“原创神作”中 创 非分隔符，不会命中“原神”）。
const SEP_RE = /[\s_.·・･﹒。,，、;；:：!！?？~～^*"'`|｜/\\()（）【】<>《》[\]—-]+/g;

// fuzzyMatch 开关的注入式取值器（默认关）。主程序在 CONFIG 就绪后调用 configureFuzzy 绑定。
let getFuzzy: () => boolean = () => false;
export function configureFuzzy(fn: () => boolean): void {
  getFuzzy = fn;
}

// 匹配前对文本的归一：全角→半角 + 小写 + 去隐形（+ fuzzy 时去分隔符）。普通词编译时用同一套，保证两侧一致。
export function normMatch(s: unknown): string {
  let t = stripInvisible(toHalfWidth(s)).toLowerCase();
  if (getFuzzy()) t = t.replace(SEP_RE, '');
  return t;
}

export interface Matcher {
  plain: RegExp | null;
  regexes: RegExp[];
  empty: boolean;
}

// 单条 /正则/ 模式体的长度上限（针对订阅/导入的不可信正则）。正常规则远不及此。
const MAX_REGEX_LEN = 1000;

// 灾难性回溯启发式（非完备，仅挡最常见形态）：量词作用于「本身含无界量词」的分组，
// 如 (a+)+ / (a*)* / (a+){2,} —— 这类对中等长度文本即可指数级回溯卡死页面。
// 命中即整条忽略；长度上限 + 本启发式共同把不可信正则的 ReDoS 面收窄到很小（彻底防护需 RE2/超时引擎）。
function looksCatastrophic(src: string): boolean {
  return /\((?:[^()]*[*+]|[^()]*\{\d+,\}?)[^()]*\)\s*(?:[*+]|\{\d+,\}?)/.test(src);
}

// 把一组规则行编译成匹配器：普通词 → 归一/转义后合并成单条正则（性能更好）；
// /.../ 行 → 各自独立编译（保留其原有 flags，如 m/s/g 语义不被合并破坏）。
export function compileLines(lines: readonly string[] | null | undefined): Matcher {
  const plainParts: string[] = [];
  const regexes: RegExp[] = [];
  for (const raw of lines || []) {
    const line = (raw || '').trim();
    if (!line) continue;
    const m = line.match(/^\/(.*)\/([a-z]*)$/);
    if (m) {
      // ReDoS 防护：过长 或 含灾难性回溯形态的 /正则/（多来自订阅/导入的不可信来源）直接忽略。
      if (m[1].length > MAX_REGEX_LEN || looksCatastrophic(m[1])) continue;
      try {
        // 剥除 g/y：编译出的 RegExp 会跨多张卡复用 .test()，全局/粘性标志会让 lastIndex 粘连导致间歇漏判。
        const flags = (m[2] || 'i').replace(/[gy]/g, '');
        regexes.push(new RegExp(m[1], flags.includes('i') ? flags : flags + 'i'));
      } catch (e) {
        /* 非法正则：忽略该行 */
      }
    } else {
      const w = normMatch(line); // 与 textHit 同一套归一（含反绕过），两侧一致
      if (w) plainParts.push(escapeRe(w));
    }
  }
  let plain: RegExp | null = null;
  if (plainParts.length) {
    try {
      plain = new RegExp(plainParts.join('|'), 'i');
    } catch (e) {
      /* 理论上不会到这里：各部分已转义 */
    }
  }
  return { plain, regexes, empty: !plain && !regexes.length };
}

export function textHit(text: unknown, matcher: Matcher | null | undefined): boolean {
  if (!text || !matcher) return false;
  if (matcher.plain && matcher.plain.test(normMatch(text))) return true;
  if (matcher.regexes.length) {
    const t = stripInvisible(text); // 正则按其原样匹配，仅去隐形字符防零宽绕过
    for (const r of matcher.regexes) if (r.test(t)) return true;
  }
  return false;
}

// 关键词作用域：行首可加 title: / up: / part: 前缀，限定只匹配 标题/UP名/分区；
// 不写前缀 = 全字段（保持历史行为）。形如 title:/正则/ 也支持（前缀剥离后仍交给 compileLines）。
export const KW_SCOPES = ['title', 'up', 'part'] as const;
export type KwScope = (typeof KW_SCOPES)[number];

export interface ScopedKw {
  all: Matcher;
  title: Matcher;
  up: Matcher;
  part: Matcher;
}

export function compileScopedKeywords(lines: readonly string[] | null | undefined): ScopedKw {
  const buckets: Record<'all' | KwScope, string[]> = { all: [], title: [], up: [], part: [] };
  for (const raw of lines || []) {
    const line = (raw || '').trim();
    if (!line) continue;
    const m = !line.startsWith('/') && line.match(/^(title|up|part)\s*:\s*(.+)$/i);
    if (m) buckets[m[1].toLowerCase() as KwScope].push(m[2].trim());
    else buckets.all.push(line);
  }
  return {
    all: compileLines(buckets.all),
    title: compileLines(buckets.title),
    up: compileLines(buckets.up),
    part: compileLines(buckets.part),
  };
}

// 针对某字段判定：无前缀(all)的词对所有字段生效，带前缀的词只对对应字段生效。
export function kwHit(scoped: ScopedKw | null | undefined, field: KwScope, text: unknown): boolean {
  if (!scoped || !text) return false;
  return textHit(text, scoped.all) || textHit(text, scoped[field]);
}

// 把多条输入拆成规则数组（正则感知）：换行总是分隔；以 / 开头的行视为整条正则、不按逗号拆
// （避免把 /震惊{2,3}/、/(a|b){1,2}/ 这类含逗号的正则拆断）；其余行才按 逗号/分号 拆。
export function splitRuleInput(raw: unknown): string[] {
  const out: string[] = [];
  for (const ln of String(raw || '').split('\n')) {
    const s = ln.trim();
    if (!s) continue;
    if (s[0] === '/') {
      out.push(s); // 整行正则，保留其中的逗号
      continue;
    }
    for (const x of s.split(/[,，;；]/)) {
      const v = x.trim();
      if (v) out.push(v);
    }
  }
  return out;
}
