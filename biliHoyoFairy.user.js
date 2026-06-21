// ==UserScript==
// @name         biliHoyoFairy · 抗击黑潮
// @namespace    https://github.com/gendu-amd/biliHoyoFairy
// @version      0.0.5
// @description  B站(bilibili)推荐流净化：屏蔽黑流量、引战视频、商业广告与不想看的 UP 主。支持按 标签/UP主/UID/关键词(可正则)/分区/时长/播放量/BV 精准过滤；覆盖首页/热门/排行榜/搜索/播放页/动态/评论区；白名单优先防误伤；右键一键屏蔽/拉黑(同步账号黑名单)；内置预置关键词库。
// @author       gendu-amd
// @match        https://www.bilibili.com/*
// @match        https://search.bilibili.com/*
// @match        https://t.bilibili.com/*
// @updateURL    https://raw.githubusercontent.com/gendu-amd/biliHoyoFairy/main/biliHoyoFairy.user.js
// @downloadURL  https://raw.githubusercontent.com/gendu-amd/biliHoyoFairy/main/biliHoyoFairy.user.js
// @connect      api.bilibili.com
// @connect      raw.githubusercontent.com
// @connect      cdn.jsdelivr.net
// @connect      gitee.com
// @connect      *
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-start
// @license      MIT
// ==/UserScript==

/*
 * 架构（拦截优先 + DOM 兜底）：
 *   1. 拦截层（主）：document-start 时 hook fetch / XHR，被动过滤 B 站自身请求的 JSON 列表
 *      （首页推荐 / 排行榜 / 热门 / 播放页相关推荐），命中规则的项直接从数组删掉，
 *      页面只渲染保留项 → 无遮罩、无留白、无闪烁，且不重发请求、不需 WBI、不触发风控。
 *   2. DOM 兜底（薄）：处理拦截层覆盖不到的部分——首屏 SSR 漏网、需联网取数的进阶维度
 *      （标签 / UP简介 / 等级）、搜索热搜词。命中即安全隐藏整张卡（不留洞）。
 *   3. 同一套规则：拦截层与 DOM 层共用 matchRule + 维度注册表，数据源不同、判定一致。
 *   4. 彻底移除：一键拉黑写入账号黑名单，刷新后不再被推荐。
 */
(function () {
  'use strict';

  /* ===================== 0. 常量与配置 ===================== */
  // 单一来源：直接读脚本头 @version，避免与常量双写漂移
  const VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '0.0.1';
  const STORE_KEY = 'bfb_config_v2';
  const SUB_STORE_KEY = 'bfb_subs_v1'; // 订阅拉取结果缓存：{ [url]: { meta, rules, lastSync, ok, count, error } }
  const BLACKLIST_MANAGE_URL = 'https://account.bilibili.com/account/blacklist';
  const BADGE = 'color:#fff;background:#fb7299;padding:0 4px;border-radius:3px'; // 控制台日志的品牌徽标样式

  // DOM 标记属性（集中常量，避免散落硬编码改一处漏一处）。卡片"已处理"标记见下方 PROCESSED。
  const ATTR_API = 'data-bfb-api'; // 卡片已发起 API 评估
  const ATTR_BLOCKED = 'data-bfb-blocked'; // 卡片已被拦截（供批量拉黑扫描）

  // —— 统一日志 ——（debug 关时零开销；err 始终输出，便于线上排查）
  function log(...args) {
    if (CONFIG.debug) console.log(`%c[biliHoyoFairy]%c`, BADGE, 'color:inherit', ...args);
  }
  function logErr(where, e) {
    try {
      console.warn(`%c[biliHoyoFairy]%c ${where}`, BADGE, 'color:#e74c3c', e);
    } catch (_) {}
  }
  // 错误边界：包装易抛错的回调/逐项处理，单点异常不拖垮整轮（B 站改版/异形 DOM 时尤其重要）
  function safe(where, fn) {
    return function () {
      try {
        return fn.apply(this, arguments);
      } catch (e) {
        logErr(where, e);
      }
    };
  }

  const DEFAULT_CONFIG = {
    enabled: true,
    reviewMode: false, // 审查模式：被拦视频不删/不隐，而是标记+就地放行，便于核对防误伤
    rightClickBlock: true,
    cardHoverBtn: false, // 悬停卡片时显示快捷「拉黑」浮层按钮（独立浮层，不改 B 站卡片 DOM）
    fuzzyMatch: true, // 反绕过：普通关键词匹配前剔除分隔符（"原 神/原.神"也命中）；隐形字符始终剔除
    blacklistCollab: false, // 拉黑联合投稿时，是否把所有合作者一并拉黑
    block: {
      keywords: [], // 命中 标题/UP名/分区（纯本地，不联网；标签匹配请用 tags 维度）；普通词=包含，/.../ =正则
      partitions: [], // 视频分区(tname)黑名单；普通词=包含，/.../ =正则（网络拦截层最准）
      upNames: [],
      uids: [],
      bvids: [],
      minDuration: 0,
      maxDuration: 0,
      minViews: 0, // 万；>0 时播放量低于此值的视频被拦
      spamLikeRatio: 0, // %；>0 时，点赞率(点赞/播放)低于此值且播放≥下方阈值的视频判为营销号/搬运号（仅 feed 有点赞数据时生效）
      spamMinViews: 10, // 万；营销号识别的最低播放门槛（避免冤枉小/新视频）
      // —— 以下为需要读取接口数据的维度（仅在开启「精确过滤」后生效）——
      tags: [], // 视频标签黑名单（标题区看不到，需调接口；支持 /正则/）
      dualTags: [], // 双重标签，"原神+鸣潮" 形式，同时命中两组才拦（治引战）
      upBio: [], // UP 简介关键词黑名单（支持 /正则/）
    },
    allow: { keywords: [], upNames: [], uids: [] },
    hideAd: false,
    hideLiveCard: false, // 屏蔽信息流里的直播推荐卡（首页/动态里链向 live.bilibili.com 的卡）
    hideHotSearch: false,
    apiFilters: false, // 精确过滤总开关（关闭时完全不联网）
    hideCharging: false, // 充电专属视频（API）
    boostFeedLoad: false, // 增大首页推荐每次请求的视频数（拦截层删项后仍保持信息流饱满，借鉴 cleaner）
    // —— 评论区过滤（独立一套，读评论组件 __data；仅在有评论的页面生效，借鉴 bilibili-cleaner）——
    comment: {
      enabled: false, // 评论区过滤总开关（关=完全不处理评论）
      keywords: [], // 评论正文关键词黑名单（独立于视频关键词；支持 /正则/、作用域前缀无意义）
      userNames: [], // 评论用户名精确黑名单
      userNameKeywords: [], // 评论用户名昵称关键词黑名单（支持 /正则/）
      minLevel: 0, // 评论者等级低于此值则隐藏（0=不启用）
      hideNoFace: false, // 默认头像且非会员（小号/水军特征）
      hideEmojiOnly: false, // 纯表情/纯 @ 的空洞评论
      hideCallOnly: false, // 只含 @其他用户、无实质内容
      hideAd: false, // 带货/导流广告评论
      hideCallBot: false, // 召唤 AI 的评论
      hideBot: false, // AI 机器人发布的评论
      allowUp: true, // 白名单：UP 主本人的评论免过滤
      allowPin: true, // 白名单：置顶评论免过滤
      allowMe: true, // 白名单：自己发布/被 @ 的评论免过滤
      collapse: true, // 命中后折叠为一行灰条（点击展开），而非直接隐藏
    },
    debug: false,
    blockedCount: 0,
    uidNames: {}, // uid -> UP 名 缓存（仅用于面板按名称展示；拉黑仍用 uid）
    // 规则订阅：每条 { url, name, enabled }。拉取到的规则数据另存于 SUB_STORE_KEY 缓存（不进 config，不外传）
    subscriptions: [],
  };

  // 预置规则库 v2：内置"起步包"。每条 = { cat 大类, name, desc, rules:{维度:[...]} }，
  // 点一下把 rules 各维度加进对应黑名单（多为关键词，也可投放标签等）。持续更新的大名单走「规则订阅」。
  const PRESET_LIBRARY = [
    { cat: '游戏黑水', name: '库洛系(鸣潮/库洛)', desc: '鸣潮 / 库洛 / 战双 等相关词', rules: { keywords: ['库洛', '库洛游戏', '呜哇', '鸣潮', '战双', '战双帕弥什', '漂泊者', '漂泊神游', '寄生神游', '寄生社区'] } },
    { cat: '引战', name: '引战话术', desc: '挑动对立的话术片段（已收敛正则、防误伤）', rules: { keywords: ['/接触wuwa后|大脑发生的异变/'] } },
    { cat: '引战', name: '引战标签', desc: '抹黑 / 拉踩类标签（需开「精确过滤」才匹配标签）', rules: { tags: ['/米哈一儿|一哭|二抄|三自爆/'] } },
    { cat: '标题党 / 营销', name: '标题党', desc: '震惊体 + 一口气看完', rules: { keywords: ['/(一口气|一次性|一天|分钟|分半|小时)(看完|带你看完|直接看完)/', '/震惊|竟然|万万没想到/'] } },
    { cat: '标题党 / 营销', name: '营销号UP名', desc: '常见营销号账号名', rules: { keywords: ['今日话题', '话题酱', '今日知乎', '大型纪录片'] } },
    { cat: '标题党 / 营销', name: '软传销', desc: '日入月入 / 为自己打工', rules: { keywords: ['/(日入|日赚|月入|月赚)\\d+/', '/(小时|内耗).+为自己打工/'] } },
    { cat: '其它', name: 'MBTI', rules: { keywords: ['/MBTI|[IE][SN][TF][JP]|I人|E人/'] } },
    { cat: '其它', name: '梗视频', rules: { keywords: ['科目三', '猫meme', '/是什么梗|梗百科|大型[纪记]录片/'] } },
    { cat: '其它', name: '含日语标题', rules: { keywords: ['/[ぁ-ヶ]/'] } },
  ];

  // 评论区已知 AI 机器人账号名单（借鉴 bilibili-cleaner extra/bots）
  const COMMENT_BOTS = new Set([
    '机器工具人', '有趣的程序员', 'AI视频小助理', 'AI视频小助理总结一下', 'AI笔记侠', 'AI视频助手',
    '哔哩哔理点赞姬', '课代表猫', 'AI课代表呀', '木几萌Moe', '星崽丨StarZai', 'AI沈阳美食家', 'AI头脑风暴',
    'GPT_5', 'Juice_AI', 'AI全文总结', 'AI视频总结', 'AI总结视频', 'AI工具集', 'Ai的评论', 'AI识片酱',
    'AI知识总结', 'AI小精灵呀', 'AI课程教学', 'Ai好记', 'MilkyAi', '视频AI问答助手',
  ]);
  // 带货/导流广告评论特征（借鉴 cleaner）
  const COMMENT_AD_RE = /(bili2233\.cn|b23\.tv)\/(mall-|cm-)|领券|gaoneng\.bilibili\.com/i;

  // 合并外部数据（存档/导入）时必须跳过这些键，否则 JSON.parse 出来的 own "__proto__"
  // 会被写进 Object.prototype，污染全局并可能破坏 B 站自身脚本。
  const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

  function deepMerge(base, override) {
    for (const k of Object.keys(override || {})) {
      if (UNSAFE_KEYS.has(k)) continue;
      if (override[k] && typeof override[k] === 'object' && !Array.isArray(override[k]) && typeof base[k] === 'object') {
        deepMerge(base[k], override[k]);
      } else {
        base[k] = override[k];
      }
    }
    return base;
  }
  // 读取存档并与默认值合并：新增字段由 deepMerge 自动补默认值，无需版本迁移。
  function loadConfig() {
    const raw = GM_getValue(STORE_KEY, null);
    if (!raw) return structuredClone(DEFAULT_CONFIG);
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return deepMerge(structuredClone(DEFAULT_CONFIG), parsed);
    } catch (e) {
      return structuredClone(DEFAULT_CONFIG);
    }
  }
  function saveConfig() {
    GM_setValue(STORE_KEY, JSON.stringify(CONFIG));
  }
  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveConfig, 1200);
  }

  // 导出：仅含可分享的规则与过滤开关，剔除统计/缓存/个人会话偏好
  const NON_PORTABLE = ['blockedCount', 'uidNames', 'enabled', 'debug', 'reviewMode', 'subscriptions'];
  function exportConfig() {
    const c = structuredClone(CONFIG);
    NON_PORTABLE.forEach((k) => delete c[k]);
    return JSON.stringify({ app: 'biliHoyoFairy', version: VERSION, config: c }, null, 2);
  }
  // 导入合并：规则数组取并集（不丢已有），对象递归，标量以导入值为准
  function mergeImport(base, inc) {
    for (const k of Object.keys(inc || {})) {
      if (UNSAFE_KEYS.has(k)) continue;
      const v = inc[k];
      if (Array.isArray(v)) {
        if (!Array.isArray(base[k])) base[k] = [];
        for (const it of v) if (!base[k].map(String).includes(String(it))) base[k].push(it);
      } else if (v && typeof v === 'object' && base[k] && typeof base[k] === 'object') {
        mergeImport(base[k], v);
      } else {
        base[k] = v;
      }
    }
  }

  const CONFIG = loadConfig();
  let sessionBlocked = 0;

  /* ===================== 0c. 规则订阅（数据层） ===================== */
  // 订阅可携带的黑名单维度（白名单/开关/统计一律不接受）；未知维度忽略（向前兼容）
  const SUB_DIMS = ['uids', 'upNames', 'keywords', 'partitions', 'tags', 'upBio', 'bvids'];
  // 纯文本行前缀 → 维度；无前缀=关键词；未知前缀忽略。行匹配正则由前缀表派生（单一来源，避免两处重复）
  const SUB_LINE_PREFIX = { uid: 'uids', up: 'upNames', kw: 'keywords', part: 'partitions', tag: 'tags', bio: 'upBio', bv: 'bvids' };
  const SUB_PREFIX_RE = new RegExp('^(' + Object.keys(SUB_LINE_PREFIX).join('|') + ')\\s*:\\s*(.+)$', 'i');

  function loadSubStore() {
    try {
      return JSON.parse(GM_getValue(SUB_STORE_KEY, '') || '{}') || {};
    } catch (e) {
      return {};
    }
  }
  function saveSubStore(store) {
    try {
      GM_setValue(SUB_STORE_KEY, JSON.stringify(store));
    } catch (e) {}
  }
  // 元数据大小写不敏感读取（JSON 用 camelCase，文本头可能用任意大小写）
  function metaGet(meta, key) {
    if (!meta) return undefined;
    if (meta[key] != null) return meta[key];
    const lk = key.toLowerCase();
    for (const k in meta) if (k.toLowerCase() === lk) return meta[k];
    return undefined;
  }
  function cmpVer(a, b) {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    return 0;
  }
  const DAY_MS = 24 * 3600e3;
  function parseExpires(s) {
    const m = String(s ?? '').trim().match(/^(\d+)\s*([hd])?/i);
    if (!m) return DAY_MS; // 默认 1 天
    const n = Math.max(1, parseInt(m[1], 10) || 1);
    return n * ((m[2] || 'd').toLowerCase() === 'h' ? 3600e3 : DAY_MS);
  }
  // 迁移层：把旧 format 的对象升级到当前结构（v1=identity；将来重命名/改维度在此加 case，旧订阅不破）
  function migrateSub(obj) {
    return obj || {};
  }
  // 清洗规则维度 → {dim: string[]}：未知维度忽略、去空去重、限量（防超大列表）
  // 上限按维度区分：Set 精确维度(uid/UP名/bv)查找 O(1)，可承载大名单；正则维度合并成单条正则，保守些。
  const SUB_CAP = { uids: 50000, upNames: 50000, bvids: 50000 };
  const SUB_CAP_DEFAULT = 5000;
  function sanitizeSubRules(rawRules) {
    const out = {};
    for (const dim of SUB_DIMS) {
      const arr = rawRules && rawRules[dim];
      if (!Array.isArray(arr)) continue;
      const max = SUB_CAP[dim] || SUB_CAP_DEFAULT;
      const seen = new Set();
      const clean = [];
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
  // 解析订阅文本 → { meta, rules }；以 { 开头按 JSON，否则按 uBlock 风格纯文本行
  function parseSubscription(text) {
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
    const meta = {};
    const buckets = {};
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
  // 汇总所有【启用】订阅的规则 → {dim: string[]}，供 buildMatchers 并入黑名单
  function collectSubRules() {
    const store = loadSubStore();
    const merged = {};
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
  function fetchSubText(url, cb) {
    if (typeof GM_xmlhttpRequest !== 'function') return cb(null, '无 GM_xmlhttpRequest');
    GM_xmlhttpRequest({
      method: 'GET',
      url,
      timeout: 15000,
      onload: (r) => (r.status >= 200 && r.status < 300 && r.responseText ? cb(r.responseText, null) : cb(null, 'HTTP ' + r.status)),
      onerror: () => cb(null, '网络错误'),
      ontimeout: () => cb(null, '超时'),
    });
  }
  // 拉取并解析一条订阅，写入缓存；cb(ok)
  function syncSubscription(url, cb) {
    fetchSubText(url, (text, err) => {
      const store = loadSubStore();
      const finish = (patch, ok) => {
        store[url] = ok ? patch : Object.assign(store[url] || {}, patch);
        saveSubStore(store);
        cb && cb(ok);
      };
      if (err || !text) return finish({ lastSync: Date.now(), ok: false, error: err || '空内容' }, false);
      try {
        const { meta, rules } = parseSubscription(text);
        const count = SUB_DIMS.reduce((n, d) => n + ((rules[d] && rules[d].length) || 0), 0);
        finish({ meta, rules, lastSync: Date.now(), ok: true, count, error: null }, true);
        const minV = metaGet(meta, 'minScriptVersion');
        if (minV && cmpVer(VERSION, minV) < 0) toast(`订阅「${metaGet(meta, 'title') || url}」建议脚本升级到 ≥ ${minV}（部分规则可能未识别）`);
      } catch (e) {
        finish({ lastSync: Date.now(), ok: false, error: '解析失败' }, false);
      }
    });
  }
  // 刷新启用中的订阅；force=true 忽略 expires 间隔。完成后若有变更则重建规则+重扫
  function refreshSubscriptions(force, done) {
    const store = loadSubStore();
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
          if (changed) rescanAfterRuleChange();
          done && done(changed);
        }
      })
    );
  }

  /* ===================== 1. 工具 ===================== */
  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(^|;\\s*)' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[2]) : '';
  }
  const lc = (s) => (s || '').toString().trim().toLowerCase();
  // 全角→半角归一（含全角空格 U+3000），防止用全角字符绕过关键词（借鉴 bilibili-cleaner toHalfWidth）
  function toHalfWidth(s) {
    return (s || '')
      .toString()
      .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/\u3000/g, ' ');
  }
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // —— 反绕过归一 ——
  // 隐形字符(零宽空格/方向控制符等)：纯绕过手段、零误伤，始终剔除。
  const INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;
  const stripInvisible = (s) => (s || '').toString().replace(INVISIBLE_RE, '');
  // 分隔符：fuzzyMatch 开启时从文本与普通词两侧一并剔除，使"原 神 / 原.神 / 原·神"也命中。
  // 只跨分隔符桥接、不跨文字，故几乎不误伤（"原创神作"中 创 非分隔符，不会命中"原神"）。
  const SEP_RE = /[\s_.·・･﹒。,，、;；:：!！?？~～^*"'`|｜/\\()（）【】<>《》\[\]—-]+/g;
  // 匹配前对文本的归一：全角→半角 + 小写 + 去隐形（+ fuzzy 时去分隔符）。普通词编译时用同一套，保证两侧一致。
  function normMatch(s) {
    let t = stripInvisible(toHalfWidth(s)).toLowerCase();
    if (CONFIG.fuzzyMatch) t = t.replace(SEP_RE, '');
    return t;
  }

  // 把一组规则行编译成匹配器：普通词 → 归一/转义后合并成单条正则（性能更好，借鉴 cleaner）；
  // /.../ 行 → 各自独立编译（保留其原有 flags，如 m/s/g 语义不被合并破坏）。
  function compileLines(lines) {
    const plainParts = [];
    const regexes = [];
    for (const raw of lines || []) {
      const line = (raw || '').trim();
      if (!line) continue;
      const m = line.match(/^\/(.*)\/([a-z]*)$/);
      if (m) {
        try {
          const flags = m[2] || 'i';
          regexes.push(new RegExp(m[1], flags.includes('i') ? flags : flags + 'i'));
        } catch (e) {}
      } else {
        const w = normMatch(line); // 与 textHit 同一套归一（含反绕过），两侧一致
        if (w) plainParts.push(escapeRe(w));
      }
    }
    let plain = null;
    if (plainParts.length) {
      try {
        plain = new RegExp(plainParts.join('|'), 'i');
      } catch (e) {}
    }
    return { plain, regexes, empty: !plain && !regexes.length };
  }
  function textHit(text, matcher) {
    if (!text || !matcher) return false;
    if (matcher.plain && matcher.plain.test(normMatch(text))) return true;
    if (matcher.regexes.length) {
      const t = stripInvisible(text); // 正则按其原样匹配，仅去隐形字符防零宽绕过
      for (const r of matcher.regexes) if (r.test(t)) return true;
    }
    return false;
  }

  // 关键词作用域：行首可加 title: / up: / part: 前缀，限定只匹配 标题/UP名/分区；
  // 不写前缀 = 全字段（保持历史行为）。前缀仅识别这三种，其它含冒号的词（如"日入500:真相"）按普通词处理。
  // 形如 title:/正则/ 也支持（前缀剥离后仍交给 compileLines 解析正则）。
  const KW_SCOPES = ['title', 'up', 'part'];
  function compileScopedKeywords(lines) {
    const buckets = { all: [], title: [], up: [], part: [] };
    for (const raw of lines || []) {
      const line = (raw || '').trim();
      if (!line) continue;
      const m = !line.startsWith('/') && line.match(/^(title|up|part)\s*:\s*(.+)$/i);
      if (m) buckets[m[1].toLowerCase()].push(m[2].trim());
      else buckets.all.push(line);
    }
    return {
      all: compileLines(buckets.all),
      title: compileLines(buckets.title),
      up: compileLines(buckets.up),
      part: compileLines(buckets.part),
    };
  }
  // 针对某字段判定：无前缀(all)的词对所有字段生效，带前缀的词只对对应字段生效
  function kwHit(scoped, field, text) {
    if (!scoped || !text) return false;
    return textHit(text, scoped.all) || textHit(text, scoped[field]);
  }
  function parseDuration(s) {
    if (!s) return null;
    const parts = s.trim().split(':').map((x) => parseInt(x, 10));
    if (parts.length < 2 || parts.some((n) => Number.isNaN(n))) return null;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }
  function parseCount(s) {
    if (!s) return null;
    const t = s.trim().replace(/[,\s]/g, '');
    const m = t.match(/^([\d.]+)\s*(万|亿)?/);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (Number.isNaN(n)) return null;
    if (m[2] === '万') n *= 1e4;
    else if (m[2] === '亿') n *= 1e8;
    return Math.round(n);
  }
  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ===================== 2. 页面模型 ===================== */
  const IS_SEARCH = location.host === 'search.bilibili.com';
  const IS_DYNAMIC = location.host === 't.bilibili.com';

  function pageType() {
    const h = location.href;
    if (IS_DYNAMIC) return '动态';
    if (h.includes('/v/popular/rank') || h.includes('/ranking')) return '排行榜';
    if (h.includes('/v/popular')) return '热门';
    if (IS_SEARCH) return '搜索页';
    if (/^https:\/\/www\.bilibili\.com\/?($|\?|#)/.test(h)) return '首页';
    if (h.includes('/video/')) return '播放页';
    return '其他';
  }

  // 「内层视频卡」选择器（兼容首页 / 热门 / 排行榜 / 搜索 / 播放页）
  const VIDEO_CARD_SELECTOR = [
    'div.bili-video-card', // 首页 / 分区 / 搜索
    'div.video-page-card-small', // 播放页右侧推荐
    'li.bili-rank-list-video__item', // 分区右侧热门
    'div.video-card', // 综合热门 / 每周必看 / 入站必刷
    'li.rank-item', // 排行榜
    'div.video-card-reco',
    'div.video-card-common',
    'div.bili-dyn-list__item', // 动态信息流（t.bilibili.com，选择器借鉴 bilibili-cleaner）
    'div.floor-card.single-card', // 首页信息流里的「直播推荐」单卡（链向 live.bilibili.com）
  ].join(',');

  // 定位要隐藏的网格格子：显式有序链，避免破坏布局。
  function cellOf(el) {
    // 直播推荐卡：外层 .floor-single-card 是带宽高占位的容器，只隐内层会留黑框，故上移到它
    const fc = el.closest('div.feed-card, div.bili-feed-card, div.floor-single-card');
    if (fc) return fc;
    if (IS_SEARCH && el.parentElement && el.parentElement !== document.body) return el.parentElement;
    return el;
  }
  // 护栏：隐藏时别误删大容器/含多卡的元素（会连带删掉加载哨兵）
  function isUnsafeHideTarget(el) {
    if (!el || el === document.body || el === document.documentElement) return true;
    if (el.matches && el.matches('.container, .feed2, .bili-feed4, #i_cecream, #app, .bili-header')) return true;
    try {
      if (el.querySelectorAll(VIDEO_CARD_SELECTOR).length > 1) return true;
    } catch (e) {}
    return false;
  }

  /* ===================== 3. 卡片信息抽取 ===================== */
  function pickText(card, selectors) {
    for (const sel of selectors) {
      const el = card.querySelector(sel);
      if (el) {
        const v = el.getAttribute('title') || el.textContent;
        if (v && v.trim()) return v.trim();
      }
    }
    return '';
  }

  // deepUid: 是否为缺 UID 的卡做昂贵的 innerHTML 兜底解析（扫描热路径按需，拉黑场景强制 true）
  function extractCardInfo(card, deepUid = true) {
    const info = { title: '', up: '', uid: '', partition: '', bvid: '', duration: null, views: null, likes: null, isLive: false, isAd: false };

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

    // 直播识别：服务于「屏蔽直播推荐卡」，并避免把直播误当广告。hideAd / hideLiveCard 任一开启才算（省热路径）。
    if (CONFIG.hideAd || CONFIG.hideLiveCard) {
      info.isLive = !!(
        card.querySelector('a[href*="live.bilibili.com"]') ||
        card.querySelector('.bili-live-card, [class*="live-card"]') ||
        /直播中|正在直播/.test(card.textContent || '')
      );
    }

    // 广告判定（含遍历全卡 span/div 找角标文案）只服务于「屏蔽广告卡」，hideAd 关时整段跳过，省热路径开销。
    if (CONFIG.hideAd) {
      const adBadge = Array.from(card.querySelectorAll('span,div')).some((el) => {
        const tx = (el.textContent || '').trim();
        return tx === '广告' || tx === '赞助' || tx === '推广';
      });
      // 仅用稳定的广告标识判定：官方广告类名 / 投流域名 / 运营推广链接 / 显式角标文案。
      // （早期版本曾用「class 字符串完全等于 'bili-video-card is-rcmd' + 全局缺某容器」启发式，
      //   极易随 B 站改版误杀正常推荐卡，已移除。）
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

  /* ===================== 4. 规则匹配（白名单优先） ===================== */
  let M = buildMatchers();
  function buildMatchers() {
    // 精确匹配维度预编译成 Set，避免每张卡每次都 map/includes/some 重建数组（大黑名单下显著更快）
    const lcSet = (arr) => new Set((arr || []).map((x) => lc(x)).filter(Boolean));
    const strSet = (arr) => new Set((arr || []).map(String));
    // 黑名单 = 用户规则 ∪ 已启用订阅规则（订阅只并入黑名单维度，不碰白名单/开关）
    const sub = collectSubRules();
    const u = (dim) => (CONFIG.block[dim] || []).concat(sub[dim] || []);
    const m = {
      blockKw: compileScopedKeywords(u('keywords')),
      blockPartition: compileLines(u('partitions')),
      allowKw: compileScopedKeywords(CONFIG.allow.keywords),
      blockTag: compileLines(u('tags')),
      upBio: compileLines(u('upBio')),
      blockUidSet: strSet(u('uids')),
      blockBvidSet: new Set(u('bvids')),
      blockUpNameSet: lcSet(u('upNames')),
      allowUidSet: strSet(CONFIG.allow.uids),
      allowUpNameSet: lcSet(CONFIG.allow.upNames),
      // 评论区维度（独立编译）
      cmtKw: compileLines(CONFIG.comment.keywords),
      cmtUserKw: compileLines(CONFIG.comment.userNameKeywords),
      cmtUserSet: lcSet(CONFIG.comment.userNames),
    };
    // 是否存在 UID 规则：决定扫描时要不要为缺 UID 的卡做昂贵的 innerHTML 兜底解析
    m.needUid = m.blockUidSet.size > 0 || m.allowUidSet.size > 0;
    // API 维度是否需要拉取（含订阅并入的规则）：标签 = 仅当有专门的「视频标签」规则；简介 = 有简介词。
    // 注意：普通关键词只匹配 标题/UP名/分区（本地、免联网），不再隐式触发每张卡的标签请求。
    m.tagActive = !m.blockTag.empty;
    m.upBioActive = !m.upBio.empty;
    return m;
  }
  // 规则版本号：每次重建自增；评论扫描据此判断某条评论是否需重新评估（避免重复处理 + 规则变更后能刷新）
  let ruleVersion = 0;
  function rebuildRules() {
    M = buildMatchers();
    ruleVersion++;
  }

  function isWhitelisted(info) {
    if (kwHit(M.allowKw, 'title', info.title)) return true;
    if (info.up && kwHit(M.allowKw, 'up', info.up)) return true;
    if (info.partition && kwHit(M.allowKw, 'part', info.partition)) return true;
    if (info.up && M.allowUpNameSet.has(lc(info.up))) return true;
    if (info.uid && M.allowUidSet.has(info.uid)) return true;
    return false;
  }

  // ——————————————————————————————————————————————————————————————
  // 维度注册表（Schema）：一处声明，多端派生
  //   match(info[,ctx]) 返回命中原因字符串或 null；命中即拦（按数组顺序）。
  //   active()         可选，当前是否启用（联网维度用它推导 apiNeeds，省去请求）。
  //   source/needs     仅联网维度：source=数据来源(tag/view/card)，needs=要拉哪个接口。
  // 新增一个过滤维度 = 往对应数组里加一条，matchRule / matchApi / apiNeeds 自动生效。
  // ——————————————————————————————————————————————————————————————

  // 本地同步维度（matchRule，按序短路）。各 match 自带空配置守卫，故无需 active。
  const SYNC_DIMS = [
    { match: (i) => (CONFIG.hideAd && i.isAd ? '广告卡' : null) },
    { match: (i) => (CONFIG.hideLiveCard && i.isLive ? '直播卡' : null) },
    {
      match: (i) => {
        const b = CONFIG.block;
        return b.minViews > 0 && i.views != null && i.views < b.minViews * 1e4 ? `播放<${b.minViews}万` : null;
      },
    },
    // 营销号/搬运号：高播放却极低赞（点赞率异常）。仅在拿得到点赞数(feed 层)时判定。
    {
      match: (i) => {
        const b = CONFIG.block;
        if (b.spamLikeRatio <= 0 || i.likes == null || !i.views) return null;
        if (i.views < b.spamMinViews * 1e4) return null;
        return (i.likes / i.views) * 100 < b.spamLikeRatio ? `营销号(赞率<${b.spamLikeRatio}%)` : null;
      },
    },
    // 关键词：标题 / UP名 / 分区任一命中即拦（标签维度在 matchApi 里补判）
    { match: (i) => (kwHit(M.blockKw, 'title', i.title) || (i.up && kwHit(M.blockKw, 'up', i.up)) || kwHit(M.blockKw, 'part', i.partition) ? '关键词' : null) },
    { match: (i) => (i.partition && textHit(i.partition, M.blockPartition) ? '分区:' + i.partition : null) },
    { match: (i) => (i.up && M.blockUpNameSet.has(lc(i.up)) ? 'UP主:' + i.up : null) },
    { match: (i) => (i.uid && M.blockUidSet.has(i.uid) ? 'UID:' + i.uid : null) },
    { match: (i) => (i.bvid && M.blockBvidSet.has(i.bvid) ? 'BV:' + i.bvid : null) },
    {
      match: (i) => {
        const b = CONFIG.block;
        if (i.duration == null) return null;
        if (b.minDuration > 0 && i.duration < b.minDuration) return `时长<${b.minDuration}s`;
        if (b.maxDuration > 0 && i.duration > b.maxDuration) return `时长>${b.maxDuration}s`;
        return null;
      },
    },
  ];

  // 联网维度（matchApi，按序短路）。source 数据缺失时跳过；active 用于 apiNeeds 推导。
  const API_DIMS = [
    {
      source: 'tag',
      needs: 'tag',
      active: () => M.tagActive, // 含订阅并入的「视频标签」维度
      match: (info, ctx) => {
        for (const t of ctx.tags) {
          if (textHit(t, M.blockTag)) return '标签:' + t;
        }
        return null;
      },
    },
    {
      source: 'tag',
      needs: 'tag',
      active: () => CONFIG.block.dualTags.length,
      match: (info, ctx) => {
        for (const group of CONFIG.block.dualTags) {
          const parts = String(group).split('+').map((s) => s.trim()).filter(Boolean);
          if (parts.length >= 2 && parts.every((p) => ctx.tags.some((t) => lc(t).includes(lc(p))))) return '双标签:' + group;
        }
        return null;
      },
    },
    {
      source: 'view',
      needs: 'view',
      active: () => CONFIG.hideCharging,
      match: (info, ctx) => (CONFIG.hideCharging && ctx.view.is_upower_exclusive ? '充电专属' : null),
    },
    {
      source: 'card',
      needs: 'card',
      active: () => M.upBioActive, // 含订阅并入的简介词
      match: (info, ctx) => (!M.upBio.empty && textHit(ctx.sign, M.upBio) ? 'UP简介' : null),
    },
  ];

  function matchRule(info) {
    if (isWhitelisted(info)) return null;
    for (const d of SYNC_DIMS) {
      const r = d.match(info);
      if (r) return r;
    }
    return null;
  }

  // 算出「联网维度」各需要哪些接口（由注册表的 active/needs 推导）
  function apiNeeds() {
    let needTag = false;
    let needView = false;
    let needCard = false;
    for (const d of API_DIMS) {
      if (!d.active()) continue;
      if (d.needs === 'tag') needTag = true;
      else if (d.needs === 'view') needView = true;
      else if (d.needs === 'card') needCard = true;
    }
    if (needCard) needView = true; // 取 card 需要 mid，无 uid 时用 view.owner 兜底
    return { needTag, needView, needCard };
  }
  // 是否有任一联网规则启用（决定要不要发请求）
  function apiRulesActive() {
    if (!CONFIG.apiFilters) return false;
    const n = apiNeeds();
    return n.needTag || n.needView || n.needCard;
  }

  // 把原始接口数据整理成匹配上下文，供 API_DIMS 的 match 共用
  function buildApiCtx(info, view, tags, cardData) {
    const ctx = { tags: tags || [], view: view || {} };
    if (cardData) {
      const c = cardData.card || cardData;
      ctx.sign = c.sign || '';
    }
    return ctx;
  }

  // 联网维度匹配：view=视频详情, tags=标签数组, cardData=UP卡片
  function matchApi(info, view, tags, cardData) {
    const ctx = buildApiCtx(info, view, tags, cardData);
    for (const d of API_DIMS) {
      if (d.source === 'tag' && !(tags && tags.length)) continue;
      if (d.source === 'view' && !view) continue;
      if (d.source === 'card' && !cardData) continue;
      const r = d.match(info, ctx);
      if (r) return r;
    }
    return null;
  }

  /* ===================== 4b. 接口层（缓存 + 限速队列 + 风控熔断，避免频繁请求） ===================== */
  // 风控熔断：B 站返回风控码时全局暂停联网并指数退避，保护账号（API 取数 + 批量拉黑共用）。
  const RISK_CODES = new Set([-352, -412, -509, -799]); // 校验失败/被拦截/请求过频
  const riskGuard = {
    until: 0,
    strikes: 0,
    blocked() {
      return Date.now() < this.until;
    },
    remaining() {
      return Math.max(0, this.until - Date.now());
    },
    // 任何联网响应都喂进来：风控码→升级退避；正常码→冷却期过后清零
    note(code) {
      if (!RISK_CODES.has(code)) {
        if (code === 0 && this.strikes && !this.blocked()) this.strikes = 0;
        return;
      }
      const wasBlocked = this.blocked();
      this.strikes = Math.min(this.strikes + 1, 6);
      const backoff = Math.min(60000, 2000 * 2 ** (this.strikes - 1)); // 2s→4s→…→封顶 60s
      this.until = Date.now() + backoff;
      if (!wasBlocked) {
        logErr('风控熔断', `code ${code}，暂停联网 ${Math.round(backoff / 1000)}s`);
        toast(`⚠️ 触发 B 站风控(code ${code})，已暂停联网 ${Math.round(backoff / 1000)} 秒以保护账号`);
      }
    },
  };

  // 小并发 + 较短冷却：兼顾速度与风控。每个请求完成后冷却 DELAY 再释放并发位。
  const API = { view: new Map(), tag: new Map(), card: new Map(), queue: [], active: 0, waiting: false, CONCURRENCY: 3, DELAY: 120 };
  function apiPump() {
    // 熔断中：不派发新请求，等退避窗口结束再恢复（已入队任务保持排队，不丢）
    if (riskGuard.blocked()) {
      if (!API.waiting) {
        API.waiting = true;
        setTimeout(() => {
          API.waiting = false;
          apiPump();
        }, riskGuard.remaining() + 50);
      }
      return;
    }
    while (API.active < API.CONCURRENCY && API.queue.length) {
      const task = API.queue.shift();
      API.active++;
      task(() => {
        setTimeout(() => {
          API.active--;
          apiPump();
        }, API.DELAY);
      });
    }
  }
  function apiEnqueue(task) {
    API.queue.push(task);
    apiPump();
  }
  function gmGet(url, cb) {
    if (typeof GM_xmlhttpRequest !== 'function') {
      cb(null);
      return;
    }
    GM_xmlhttpRequest({
      method: 'GET',
      url,
      withCredentials: true,
      timeout: 12000,
      onload: (r) => {
        try {
          const j = JSON.parse(r.responseText);
          riskGuard.note(j && j.code); // 风控码喂给熔断器
          cb(j);
        } catch (e) {
          cb(null);
        }
      },
      onerror: () => cb(null),
      ontimeout: () => cb(null),
    });
  }
  function fetchView(bvid, cb) {
    if (!bvid) return cb(null);
    if (API.view.has(bvid)) return cb(API.view.get(bvid));
    apiEnqueue((done) => {
      gmGet('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid), (j) => {
        const d = j && j.code === 0 ? j.data : null;
        API.view.set(bvid, d); // d.owner.mid 即可反查 uid，无需另设缓存
        if (d && d.owner && d.owner.mid && d.owner.name) {
          CONFIG.uidNames[String(d.owner.mid)] = d.owner.name; // 持久化：面板按名展示
          scheduleSave();
        }
        cb(d);
        done();
      });
    });
  }
  function fetchTags(bvid, cb) {
    if (!bvid) return cb(null);
    if (API.tag.has(bvid)) return cb(API.tag.get(bvid));
    apiEnqueue((done) => {
      gmGet('https://api.bilibili.com/x/web-interface/view/detail/tag?bvid=' + encodeURIComponent(bvid), (j) => {
        const arr = j && j.code === 0 && Array.isArray(j.data) ? j.data.map((x) => x.tag_name).filter(Boolean) : null;
        API.tag.set(bvid, arr);
        cb(arr);
        done();
      });
    });
  }
  function fetchCard(mid, cb) {
    if (!mid) return cb(null);
    if (API.card.has(mid)) return cb(API.card.get(mid));
    apiEnqueue((done) => {
      gmGet('https://api.bilibili.com/x/web-interface/card?mid=' + encodeURIComponent(mid), (j) => {
        const d = j && j.code === 0 ? j.data : null;
        API.card.set(mid, d);
        cb(d);
        done();
      });
    });
  }
  // 从 view 缓存里同步取 uid（已请求过的 bvid 才有；否则返回空串）
  function cachedUid(bvid) {
    const d = bvid && API.view.get(bvid);
    return d && d.owner && d.owner.mid ? String(d.owner.mid) : '';
  }

  /* ===================== 4c. 网络拦截层（数据层过滤，主路径） ===================== */
  // hook fetch / XHR，被动过滤 B 站自身请求的 JSON 列表：把命中本地规则的项从数组删掉，
  // 让页面只渲染保留项。只读不发——不重发请求、不需 WBI 签名、不触发风控。
  // 进阶维度（标签 / 简介 / 等级，需额外接口）与首屏 SSR 漏网仍由 DOM 兜底层处理。

  // 各接口的「列表项」归一成与 extractCardInfo 同形状的 info（rcmd/ranking/popular/related 同构）
  function normFeedItem(it) {
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
      title: rawTitle.replace(/<[^>]*>/g, ''),
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

  // 接口注册：re=URL 匹配，get=从 data 里取出可过滤的数组（就地 splice 即生效）
  const FEED_HOOKS = [
    { re: /\/x\/web-interface\/wbi\/index\/top\/feed\/rcmd/, get: (d) => (d && Array.isArray(d.item) ? d.item : null) },
    { re: /\/x\/web-interface\/index\/top\/feed\/rcmd/, get: (d) => (d && Array.isArray(d.item) ? d.item : null) },
    { re: /\/x\/web-interface\/ranking\/v2/, get: (d) => (d && Array.isArray(d.list) ? d.list : null) },
    { re: /\/x\/web-interface\/popular(\/|\?|$)/, get: (d) => (d && Array.isArray(d.list) ? d.list : null) },
    { re: /\/x\/web-interface\/archive\/related/, get: (d) => (Array.isArray(d) ? d : null) },
    // 搜索页：type=视频 时 data.result 直接是视频数组；综合(all/v2) 时 data.result 是分组，取 result_type==='video' 的 data
    {
      re: /\/x\/web-interface\/wbi\/search\/(type|all\/v2)/,
      get: (d) => {
        if (!d || !Array.isArray(d.result)) return null;
        if (d.result.length && d.result[0] && d.result[0].result_type) {
          const g = d.result.find((x) => x.result_type === 'video');
          return g && Array.isArray(g.data) ? g.data : null;
        }
        return d.result;
      },
    },
  ];
  const isFeedUrl = (url) => !!url && FEED_HOOKS.some((h) => h.re.test(url));

  // 就地过滤一个已解析的 JSON 响应：命中项从 json.data 的数组里原地 splice 删除。
  // 返回删除条数（0 表示未改动），调用方据此决定是否需要重建响应/重序列化。
  function filterFeedJson(url, json) {
    // 审查模式下不在数据层删项，让视频照常渲染，交给 DOM 层标记，便于核对
    if (!CONFIG.enabled || CONFIG.reviewMode || !json || json.code !== 0 || !json.data) return 0;
    const hook = FEED_HOOKS.find((h) => h.re.test(url));
    if (!hook) return 0;
    const arr = hook.get(json.data);
    if (!arr || !arr.length) return 0;
    let removed = 0;
    for (let i = arr.length - 1; i >= 0; i--) {
      const info = normFeedItem(arr[i]);
      if (!info) continue; // 白名单由 matchRule 内部短路，无需在此重复判断
      const reason = matchRule(info);
      if (reason) {
        recordBlock(reason, info, 'NET');
        arr.splice(i, 1);
        removed++;
      }
    }
    if (removed) log(`拦截层 删除 ${removed} 项 @ ${url.split('?')[0]}`);
    return removed;
  }
  // ===== 可插拔网络管线（借鉴 cleaner FetchHook，但以「JSON 原地过滤」为中心，fetch 与 XHR 共用一套）=====
  // preFn:  (url:string) => newUrl|void   —— 渲染前改写请求 URL（仅处理字符串 URL）
  // postFn: (url, json)  => removedCount  —— 原地修改解析后的 JSON，返回删除条数
  const NET = (() => {
    const preFns = [];
    const postFns = [];
    return {
      addPre: (fn) => preFns.push(fn),
      addPost: (fn) => postFns.push(fn),
      hasPre: () => preFns.length > 0,
      rewriteUrl(url) {
        let u = url;
        for (const fn of preFns) {
          try {
            const r = fn(u);
            if (typeof r === 'string' && r) u = r;
          } catch (e) {}
        }
        return u;
      },
      runJson(url, json) {
        let removed = 0;
        for (const fn of postFns) {
          try {
            removed += fn(url, json) || 0;
          } catch (e) {}
        }
        return removed;
      },
    };
  })();

  // 注册唯一的内容过滤 postFn（即原 filterFeedJson）；以后新增过滤器只需再 addPost 一条。
  NET.addPost(filterFeedJson);
  // 注册「增大首页推荐请求数」preFn（默认关，opt-in）：拦截层会删项，调大 ps 可让信息流删后仍饱满。
  NET.addPre((url) => {
    if (!CONFIG.boostFeedLoad) return;
    if (/\/x\/web-interface\/(wbi\/)?index\/top\/feed\/rcmd/.test(url) && /[?&]ps=\d+/.test(url)) {
      return url.replace(/([?&]ps=)\d+/, '$1' + 30);
    }
  });

  // 过滤文本响应：无删项时原样返回 raw（省一次序列化、且保持字节一致）
  function computeFilteredText(url, raw) {
    try {
      const json = JSON.parse(raw);
      return NET.runJson(url, json) ? JSON.stringify(json) : raw;
    } catch (e) {
      return raw;
    }
  }

  function installNetworkHooks() {
    const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    // —— fetch —— 
    const RespCtor = W.Response || Response;
    if (typeof W.fetch === 'function' && !W.fetch.__bfb) {
      const origFetch = W.fetch;
      const wrapped = function (input, init) {
        // 请求改写（preFn）：仅当输入是字符串 URL 时处理，避免重建 Request 对象的副作用
        let input2 = input;
        if (NET.hasPre() && typeof input === 'string') input2 = NET.rewriteUrl(input);
        const url = typeof input2 === 'string' ? input2 : (input2 && input2.url) || '';
        const p = origFetch.call(this, input2, init);
        if (!isFeedUrl(url)) return p;
        return p.then((resp) =>
          resp
            .clone()
            .json()
            .then((json) => {
              // 无命中删项：原样返回真实响应，保留 url/type/redirected 等元信息，且不重序列化
              if (!NET.runJson(url, json)) return resp;
              // 有删项才重建响应：剔除 content-encoding/length（正文已是明文 JSON，旧头会误导消费者）
              const h = new Headers(resp.headers);
              h.delete('content-encoding');
              h.delete('content-length');
              return new RespCtor(JSON.stringify(json), { status: resp.status, statusText: resp.statusText, headers: h });
            })
            .catch(() => resp)
        );
      };
      wrapped.__bfb = true;
      try {
        W.fetch = wrapped;
      } catch (e) {}
    }

    // —— XMLHttpRequest —— 在 open 时给目标请求实例装上惰性 getter，
    // 读取时（readyState 4）才解析+过滤，规避页面处理器先于我们读取的时序问题。
    const XHR = W.XMLHttpRequest;
    if (XHR && XHR.prototype && !XHR.prototype.__bfb) {
      const origOpen = XHR.prototype.open;
      const dText = Object.getOwnPropertyDescriptor(XHR.prototype, 'responseText');
      const dResp = Object.getOwnPropertyDescriptor(XHR.prototype, 'response');
      XHR.prototype.open = function (method, url) {
        const self = this;
        // 请求改写（preFn）：仅处理字符串 URL
        const url2 = NET.hasPre() && typeof url === 'string' ? NET.rewriteUrl(url) : url;
        if (isFeedUrl(url2)) {
          // 同一次响应只过滤一次：responseText 与 response(text 型) 共用这份文本 memo，
          // 避免消费者同时读两者时过滤跑两遍、导致计数与屏蔽记录翻倍。
          const filteredText = (getRaw) => {
            if (self.__bfbText === undefined) self.__bfbText = computeFilteredText(url2, getRaw());
            return self.__bfbText;
          };
          if (dText && dText.get) {
            Object.defineProperty(self, 'responseText', {
              configurable: true,
              get() {
                if (self.readyState !== 4) return dText.get.call(self);
                return filteredText(() => dText.get.call(self));
              },
            });
          }
          if (dResp && dResp.get) {
            Object.defineProperty(self, 'response', {
              configurable: true,
              get() {
                if (self.readyState !== 4) return dResp.get.call(self);
                const rt = self.responseType;
                // json 型只能读 .response（读 responseText 会抛错），单独 memo 一份对象
                if (rt === 'json') {
                  if (self.__bfbResp === undefined) {
                    const orig = dResp.get.call(self);
                    try {
                      if (orig && typeof orig === 'object') NET.runJson(url2, orig); // 原地删项
                      self.__bfbResp = orig;
                    } catch (e) {
                      self.__bfbResp = orig;
                    }
                  }
                  return self.__bfbResp;
                }
                // text/'' 型：与 responseText 共用同一份文本 memo
                if (rt === '' || rt === 'text') {
                  const orig = dResp.get.call(self);
                  return typeof orig === 'string' ? filteredText(() => orig) : orig;
                }
                return dResp.get.call(self);
              },
            });
          }
        }
        // 用改写后的 url2 调原始 open（保留 async/user/password 透传）
        return origOpen.call(this, method, url2, arguments.length > 2 ? arguments[2] : true, arguments[3], arguments[4]);
      };
      XHR.prototype.__bfb = true;
    }
  }

  // hook Element.prototype.attachShadow：把页面创建的每个开放 shadowRoot 收进注册表（评论组件定位、卡片穿透共用）。
  // 必须在 document-start 安装，先于 B 站构建评论 Web Component。借鉴 bilibili-cleaner Shadow.hook。
  function installShadowHook() {
    if (Element.prototype.attachShadow.__bfb) return;
    const orig = Element.prototype.attachShadow;
    const wrapped = function (init) {
      const root = orig.call(this, init);
      try {
        shadowRoots.add(root);
        if (CMT_TAGS[this.tagName] !== undefined) scheduleCommentScan();
      } catch (e) {}
      return root;
    };
    wrapped.__bfb = true;
    try {
      Element.prototype.attachShadow = wrapped;
    } catch (e) {}
  }

  /* ===================== 5. 拦截执行 ===================== */
  const PROCESSED = 'data-bfb-done';
  const blockedLog = [];
  const countedEls = new WeakSet();
  // 按拦截原因聚合计数，供面板「分类」与启动汇总共用
  function tallyLog() {
    const t = {};
    for (const b of blockedLog) t[b.reason] = (t[b.reason] || 0) + 1;
    return t;
  }
  let panelStatsRefresh = null; // 面板打开时的"屏蔽记录"刷新器，命中时实时更新计数

  function logBlocked(reason, info, src) {
    blockedLog.unshift({
      title: (info && info.title) || '',
      up: (info && info.up) || '',
      uid: (info && info.uid) || '',
      bvid: (info && info.bvid) || '',
      link: (info && info.link) || '',
      src: src || 'DOM', // NET=网络拦截层（渲染前删项）/ DOM=兜底隐藏
      reason,
      t: Date.now(),
    });
    if (blockedLog.length > 300) blockedLog.pop();
  }

  // 撤销 DOM 层对某卡的隐藏 / 审查标记（规则变更后重扫时调用）
  function clearVisual(card) {
    card.style.display = '';
    card.classList.remove('bfb-review');
    const t = card.querySelector(':scope > .bfb-tag');
    if (t) t.remove();
    card.removeAttribute(ATTR_BLOCKED);
    const cell = cellOf(card);
    if (cell !== card) cell.style.display = '';
  }

  // 审查模式：不隐藏，给卡片打醒目标记 + 原因 + 就地「放行」按钮，便于核对防误伤
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

  // 记账：计数 + 日志 + 角标 + 面板刷新。拦截层（无 card）与 DOM 层共用。
  function recordBlock(reason, info, src) {
    logBlocked(reason, info, src);
    sessionBlocked++;
    CONFIG.blockedCount++;
    if (document.body) updateBadge(); // document-start 时 body 可能还没就绪
    if (panelStatsRefresh && isPanelOpen()) panelStatsRefresh();
    scheduleSave();
    log(`拦截🚫 ${reason} ${info && info.up ? info.up + ' · ' : ''}${(info && info.title) || '(无标题)'}`);
  }

  // DOM 兜底层：审查模式标记、否则直接隐藏漏网卡。主路径由网络拦截层在渲染前就删除。
  function blockVideo(card, reason, info) {
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

  // 单卡处理用错误边界包裹：异形卡导致 extractCardInfo/matchRule 抛错时，只跳过这一张、不中断整轮扫描
  const processCard = safe('processCard', function (card) {
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

  // 异步评估：只取需要的接口，命中则隐藏/标记（与本地规则同一套出口 blockVideo）
  function evaluateApi(card, info) {
    if (card.getAttribute(ATTR_API)) return;
    card.setAttribute(ATTR_API, '1');
    const need = apiNeeds();
    let view = null;
    let tags = null;
    let cardData = null;
    let pending = 0;
    const finish = () => {
      if (pending > 0) return;
      if (!CONFIG.enabled || isWhitelisted(info)) return;
      const hit = matchApi(info, view, tags, cardData);
      if (hit) blockVideo(card, hit, info);
      else log(`API放行 | ${info.title || ''}`);
    };
    const afterView = () => {
      // UP 卡片需要 mid：优先 DOM 抠的，没有就用 view.owner.mid
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
  }

  // 已知的开放 Shadow Root 注册表：部分卡片可能渲染在 shadow DOM 内，普通 querySelectorAll 选不中。
  // 启动时全量采集一次，之后只在 MutationObserver 的新增节点子树里增量采集，避免每次扫描全量遍历（借鉴 codertesla queryAllDeep）。
  const shadowRoots = new Set();
  function harvestShadowRoots(root) {
    if (!root || !root.querySelectorAll) return;
    let nodes;
    try {
      nodes = root.querySelectorAll('*');
    } catch (e) {
      return;
    }
    for (const el of nodes) {
      if (el.shadowRoot && el.id !== 'bfb-overlay-host' && !shadowRoots.has(el.shadowRoot)) {
        shadowRoots.add(el.shadowRoot);
      }
    }
  }
  // 普通 DOM 卡片 ∪ 各存活 shadow root 内的卡片
  function queryCards() {
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

  function scanAll() {
    if (!CONFIG.enabled) return;
    queryCards().forEach((card) => {
      if (card.getAttribute(PROCESSED)) return;
      if (card.closest && card.closest('.recommended-swipe')) return; // 顶部轮播 banner，跳过
      processCard(card);
    });
  }

  function rescanAfterRuleChange() {
    rebuildRules();
    document.querySelectorAll('[' + PROCESSED + ']').forEach((el) => {
      el.removeAttribute(PROCESSED);
      el.removeAttribute(ATTR_API);
      clearVisual(el);
    });
    scanAll();
    scanComments(); // ruleVersion 已自增，评论会按新规则重判
  }

  /* ===================== 5c. 评论区过滤（读评论组件 __data，DOM 层隐藏） ===================== */
  // B 站新版评论是 Web Component（bili-comment-thread-renderer=一级 / bili-comment-reply-renderer=二级），
  // 数据挂在宿主元素的 .__data 上。我们靠 attachShadow 钩子把这些组件的 shadowRoot 收进 shadowRoots，
  // 再读 __data 判定、隐藏。全部字段访问走可选链，缺字段=不命中，绝不抛错。
  const CMT_TAGS = { 'BILI-COMMENT-THREAD-RENDERER': false, 'BILI-COMMENT-REPLY-RENDERER': true };

  // 归一评论正文：去掉开头"回复 @x:"、去 @提及、去 [表情] 占位，便于关键词/空洞判定
  function cmtCleanMsg(msg, isSub) {
    let s = (msg || '').toString();
    if (isSub) s = s.replace(/^回复\s?@[^@\s:：]+\s?[:：]/, '');
    return s.replace(/@[^@\s]+/g, ' ').replace(/(\[[^[\]]+\])+/g, ' ').trim();
  }
  // 去表情后是否为空（纯表情/纯 @）
  const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u200d\u{20E3}]/gu;

  function readCmt(host) {
    const d = (host && host.__data) || {};
    const member = d.member || {};
    const content = d.content || {};
    const lv = member.level_info && member.level_info.current_level;
    const vipStatus = member.vip && member.vip.vipStatus;
    return {
      uname: ((member.uname || '') + '').trim(),
      mid: d.mid,
      level: typeof lv === 'number' ? lv : null,
      noface: (member.avatar || '').endsWith('noface.jpg') && (vipStatus === 0 || vipStatus == null),
      message: (content.message || '') + '',
      members: Array.isArray(content.members) ? content.members : [],
      isUpTop: !!(d.reply_control && d.reply_control.is_up_top),
      upMid: host.__upMid, // B 站组件挂的视频 UP mid（可能缺，缺则 isUp 白名单不生效）
      me: host.__user && host.__user.uname, // 当前登录用户名（可能缺）
    };
  }

  // 返回命中原因或 null。白名单优先（UP/置顶/自己）。
  function matchComment(c, isSub) {
    const cc = CONFIG.comment;
    // —— 白名单 ——
    if (cc.allowUp && c.upMid != null && c.mid != null && String(c.mid) === String(c.upMid)) return null;
    if (cc.allowPin && !isSub && c.isUpTop) return null;
    if (cc.allowMe && c.me && (c.uname === c.me || c.message.includes('@' + c.me))) return null;
    // —— 黑名单 ——
    if (c.uname && M.cmtUserSet.has(lc(c.uname))) return '评论用户:' + c.uname;
    if (c.uname && textHit(c.uname, M.cmtUserKw)) return '评论昵称词';
    const clean = cmtCleanMsg(c.message, isSub);
    if (textHit(clean, M.cmtKw)) return '评论关键词';
    if (cc.minLevel > 0 && c.level != null && c.level < cc.minLevel) return `评论等级<${cc.minLevel}`;
    if (cc.hideNoFace && c.noface) return '默认头像非会员';
    if (cc.hideBot && c.uname && COMMENT_BOTS.has(c.uname)) return 'AI机器人';
    if (cc.hideCallBot && c.members.some((m) => m && COMMENT_BOTS.has(m.uname))) return '召唤AI';
    if (cc.hideAd && COMMENT_AD_RE.test(c.message)) return '带货评论';
    if (cc.hideCallOnly && c.message.replace(/@[^@\s]+/g, ' ').trim() === '') return '纯@评论';
    if (cc.hideEmojiOnly && clean.replace(EMOJI_RE, '').trim() === '') return '纯表情评论';
    return null;
  }

  // 折叠：把命中评论收成一行灰条（点击展开），而非直接隐藏。占位条插在宿主前，宿主仍 display:none。
  // 占位条处于评论组件的 shadowRoot 内，文档级 CSS 够不着，样式必须全内联。
  function collapseComment(host, reason) {
    if (host.__bfbCmtPh && host.__bfbCmtPh.isConnected) {
      // 已折叠：仅更新原因文案
      const t = host.__bfbCmtPh.querySelector('.bfb-ph-txt');
      if (t) t.textContent = '已折叠 · 命中：' + reason;
      return;
    }
    const parent = host.parentNode;
    if (!parent) {
      host.style.setProperty('display', 'none', 'important');
      return;
    }
    const ph = document.createElement('div');
    ph.className = 'bfb-cmt-ph';
    ph.style.cssText =
      'display:flex;align-items:center;gap:8px;margin:4px 0;padding:6px 10px;border-radius:8px;' +
      'background:rgba(251,114,153,.08);border:1px dashed rgba(251,114,153,.45);' +
      'font-size:12px;color:#9499a0;cursor:pointer;user-select:none;line-height:1.5';
    ph.innerHTML =
      '<span class="bfb-ph-txt" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">已折叠 · 命中：' +
      String(reason).replace(/[<>&]/g, '') +
      '</span><span style="color:#fb7299;flex:none">点击展开 ▾</span>';
    ph.addEventListener('click', function () {
      ph.remove();
      host.style.removeProperty('display');
      host.__bfbCmtPh = null;
      host.__bfbCmtExpanded = true; // 用户已手动展开，后续重扫不再折叠
    });
    parent.insertBefore(ph, host);
    host.__bfbCmtPh = ph;
    host.style.setProperty('display', 'none', 'important');
  }
  function removeCmtPlaceholder(host) {
    if (host.__bfbCmtPh) {
      try {
        host.__bfbCmtPh.remove();
      } catch (e) {}
      host.__bfbCmtPh = null;
    }
  }

  // 处理单条评论宿主（错误边界 + 版本号去重）
  const processComment = safe('processComment', function (host, isSub) {
    if (host.__bfbCmtV === ruleVersion) return; // 本版本已评估过
    host.__bfbCmtV = ruleVersion;
    const c = readCmt(host);
    if (!c.uname && !c.message) return; // 还没渲染出数据，等下一轮
    const reason = matchComment(c, isSub);
    if (reason) {
      if (CONFIG.reviewMode) {
        removeCmtPlaceholder(host);
        host.style.setProperty('outline', '2px solid #fb7299', 'important');
        host.title = '[biliHoyoFairy] 命中：' + reason;
        host.style.removeProperty('display');
      } else if (CONFIG.comment.collapse && !host.__bfbCmtExpanded) {
        collapseComment(host, reason);
      } else if (host.__bfbCmtExpanded) {
        // 用户已展开过：保持可见，不再折叠/隐藏
        removeCmtPlaceholder(host);
        host.style.removeProperty('display');
      } else {
        // 评论组件常带 :host{display:..!important}，必须用 important 内联才能压过
        removeCmtPlaceholder(host);
        host.style.setProperty('display', 'none', 'important');
      }
      if (!host.__bfbCmtHit) {
        host.__bfbCmtHit = true;
        recordBlock(reason, { up: c.uname, title: cmtCleanMsg(c.message, isSub).slice(0, 40) }, 'CMT');
      }
    } else {
      // 不命中：撤销之前可能的隐藏/折叠/标记（规则放宽后恢复）
      removeCmtPlaceholder(host);
      host.style.removeProperty('display');
      host.style.removeProperty('outline');
      host.removeAttribute('title');
      host.__bfbCmtHit = false;
      host.__bfbCmtExpanded = false;
    }
  });

  // 还原所有被评论过滤隐藏/标记的评论（关闭过滤时调用）
  function revertComments() {
    for (const root of shadowRoots) {
      const host = root && root.host;
      if (!host || CMT_TAGS[host.tagName] === undefined) continue;
      if (host.__bfbCmtHit || host.__bfbCmtPh || host.style.display === 'none' || host.style.outline) {
        removeCmtPlaceholder(host);
        host.style.removeProperty('display');
        host.style.removeProperty('outline');
        host.removeAttribute('title');
        host.__bfbCmtHit = false;
        host.__bfbCmtExpanded = false;
        host.__bfbCmtV = undefined;
      }
    }
  }
  let lastCmtDiag = '';
  function scanComments() {
    if (!CONFIG.enabled || !CONFIG.comment.enabled) {
      revertComments(); // 关闭时恢复曾隐藏的评论
      return;
    }
    let cmtHosts = 0;
    for (const root of shadowRoots) {
      const host = root && root.host;
      if (!host) continue;
      if (!host.isConnected) {
        shadowRoots.delete(root);
        continue;
      }
      const isSub = CMT_TAGS[host.tagName];
      if (isSub === undefined) continue;
      cmtHosts++;
      processComment(host, isSub);
    }
    // 诊断：调试模式下，输出当前捕获到的全部 shadow 宿主标签 + 评论宿主数（标签集变化才打，避免刷屏）
    if (CONFIG.debug) {
      const tags = {};
      for (const r of shadowRoots) {
        const h = r && r.host;
        if (h && h.tagName) tags[h.tagName] = (tags[h.tagName] || 0) + 1;
      }
      const sig = JSON.stringify(tags);
      if (sig !== lastCmtDiag) {
        lastCmtDiag = sig;
        log(`评论诊断｜shadowRoot 总数=${shadowRoots.size}｜评论宿主=${cmtHosts}｜各标签计数=`, tags);
      }
    }
  }
  // 评论增量很碎（每条评论各自 attachShadow），用节流聚合扫描
  let cmtTimer = null;
  function scheduleCommentScan() {
    if (!CONFIG.comment.enabled) return;
    if (cmtTimer) return;
    cmtTimer = setTimeout(() => {
      cmtTimer = null;
      scanComments();
    }, 300);
  }

  function addToList(arr, value) {
    const v = (value || '').trim();
    if (!v) return false;
    if (arr.map(String).includes(v)) return false;
    arr.push(v);
    saveConfig();
    rescanAfterRuleChange();
    return true;
  }
  function removeFromList(arr, value) {
    const i = arr.map(String).indexOf(String(value));
    if (i >= 0) {
      arr.splice(i, 1);
      saveConfig();
      rescanAfterRuleChange();
    }
  }

  /* ===================== 6. 一键拉黑（relation/modify act=5） ===================== */
  // 用 BV 号反查 UP 的 uid/name（页面取不到 UID 时的兜底，走视频详情接口）
  // 复用接口层的 view 缓存与限速队列。
  function resolveUidByBvid(bvid, cb) {
    // fetchView 自带缓存：命中即同步回调，无需在此另设缓存分支
    fetchView(bvid, (d) => {
      if (d && d.owner) cb(String(d.owner.mid), d.owner.name || '');
      else cb('', '');
    });
  }

  // relation/modify 常见错误码 → 友好文案（借鉴 codertesla bilibili-1-click-blocker）
  const REL_ERR = {
    '-101': '未登录或登录已过期',
    '-111': 'CSRF 校验失败，请刷新页面重试',
    '-352': '触发 B 站风控，请稍后再试',
    22120: '该用户已在你的黑名单中',
  };

  // 真正调接口拉黑（已确定 uid）。quiet=true 时不弹单条提示（批量/联合投稿场景由调用方汇总）。
  function doBlacklist(uid, upName, cb, quiet) {
    const label = upName || uid;
    const addLocal = () => {
      if (upName) CONFIG.uidNames[String(uid)] = upName;
      addToList(CONFIG.block.uids, String(uid));
    };
    const csrf = getCookie('bili_jct');
    if (!csrf) {
      addLocal();
      if (!quiet) toast(`未登录，已本地屏蔽「${label}」(未同步账号黑名单)`);
      cb && cb(false, -101);
      return;
    }
    GM_xmlhttpRequest({
      method: 'POST',
      url: 'https://api.bilibili.com/x/relation/modify',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      // gaia_source=web_main 贴合当前官方 web 端行为，降低被风控/失败概率（借鉴 codertesla）
      data: `fid=${encodeURIComponent(uid)}&act=5&re_src=11&gaia_source=web_main&csrf=${encodeURIComponent(csrf)}`,
      withCredentials: true,
      onload: (res) => {
        let code = null;
        let msg = '';
        try {
          const j = JSON.parse(res.responseText);
          code = j.code;
          msg = j.message || '';
        } catch (e) {}
        riskGuard.note(code); // 拉黑响应也喂给熔断器（批量拉黑触发风控时全局退避）
        addLocal();
        // 22120 = 已在黑名单，视作成功（幂等）
        const ok = code === 0 || code === 22120;
        // 成功拉黑写入屏蔽记录（单发/批量共用），让用户能看到"这次拉黑了谁"
        if (ok) logBlocked('拉黑', { up: upName || (CONFIG.uidNames && CONFIG.uidNames[String(uid)]) || '', uid: String(uid) }, 'BL');
        if (!quiet) {
          if (code === 0) toast(`已拉黑并同步账号黑名单：${label}（刷新后不再推荐）`);
          else if (code === 22120) toast(`「${label}」此前已在账号黑名单，已本地同步`);
          else toast(`账号侧拉黑失败（${REL_ERR[code] || msg || 'code ' + code}），已本地屏蔽：${label}`);
        }
        cb && cb(ok, code);
      },
      onerror: () => {
        addLocal();
        if (!quiet) toast(`网络错误，已本地屏蔽：${label}`);
        cb && cb(false, null);
      },
    });
  }

  // 顺序拉黑多个 UP。targets:[{uid,name}]。按真实返回码如实分类，避免"谎报"。
  //   cb({ added, already, failed:[{uid,code}], total })  —— 完成回调
  //     added=本次新拉黑(code 0)；already=此前已在黑名单(22120)；failed=真正没拉成(风控/未登录/其它)
  //   onProgress({done,added,already,ok,fail,total,paused,wait}) —— 实时进度（可选）
  // 限速 + 抖动：批量比单发更保守，降低被风控概率；触发风控由 riskGuard 自动指数退避并在此暂停等待。
  const BL_DELAY = 900; // 每次之间基础间隔(ms)
  const BL_JITTER = 700; // 叠加随机抖动(ms)，降低规律性
  function doBlacklistMany(targets, cb, onProgress) {
    const list = [];
    const seen = new Set();
    for (const t of targets) {
      const uid = String((t && t.uid) || '');
      if (uid && !seen.has(uid)) {
        seen.add(uid);
        list.push({ uid, name: (t && t.name) || '' });
      }
    }
    let added = 0; // code 0：本次新写入账号黑名单
    let already = 0; // 22120：此前已在黑名单（不会让官方名单数量再增加）
    let done = 0;
    let i = 0;
    const failed = []; // { uid, code }：真正没拉成的
    const snapshot = (paused) => ({
      done,
      added,
      already,
      ok: added + already,
      fail: failed.length,
      total: list.length,
      paused: !!paused,
      wait: paused ? Math.ceil(riskGuard.remaining() / 1000) : 0,
    });
    const report = (paused) => onProgress && onProgress(snapshot(paused));
    const finish = () => {
      if (CONFIG.debug && failed.length) {
        const byCode = {};
        failed.forEach((f) => (byCode[f.code] = (byCode[f.code] || 0) + 1));
        log('批量拉黑失败按 code 分布：', byCode, failed);
      }
      cb && cb({ added, already, failed, total: list.length });
    };
    const next = () => {
      if (i >= list.length) return finish();
      // 熔断中：等退避窗口结束再继续，并把"暂停中 + 已完成进度"实时告知调用方（避免用户以为卡死）
      if (riskGuard.blocked()) {
        report(true);
        setTimeout(next, riskGuard.remaining() + 50);
        return;
      }
      const t = list[i++];
      doBlacklist(
        t.uid,
        t.name,
        (s, code) => {
          done++;
          if (code === 0) added++;
          else if (code === 22120) already++;
          else failed.push({ uid: t.uid, code });
          report(false);
          setTimeout(next, BL_DELAY + Math.random() * BL_JITTER);
        },
        true
      );
    };
    if (!list.length) finish();
    else next();
  }

  // 入口：info 至少含 up；优先用 uid，没有则用 bvid 反查；都没有才退回按 UP 名本地屏蔽。
  // 传 cardEl 时会先实时重抠一遍 DOM（避免用到首屏未渲染时缓存的空 uid）。
  function blacklistUp(info, cb, cardEl) {
    let uid = info && info.uid ? String(info.uid) : '';
    let upName = (info && info.up) || '';
    let bvid = (info && info.bvid) || '';
    if (cardEl) {
      const live = extractCardInfo(cardEl);
      uid = uid || live.uid;
      upName = upName || live.up;
      bvid = bvid || live.bvid;
    }
    // 联合投稿：开了开关且能拿到 BV → 读取合作者名单，主作者 + 全部合作者一并拉黑
    if (CONFIG.blacklistCollab && bvid) {
      toast('正在读取联合投稿名单…');
      fetchView(bvid, (d) => {
        const targets = [];
        if (d && d.owner) targets.push({ uid: d.owner.mid, name: d.owner.name || '' });
        if (d && Array.isArray(d.staff)) d.staff.forEach((s) => targets.push({ uid: s.mid, name: s.name || '' }));
        if (!targets.length && uid) targets.push({ uid, name: upName });
        if (!targets.length) {
          if (upName) {
            addToList(CONFIG.block.upNames, upName);
            toast(`未能解析名单，已按 UP 名本地屏蔽：${upName}`);
          } else {
            toast('该卡片信息不足，无法拉黑');
          }
          cb && cb(false);
          return;
        }
        doBlacklistMany(targets, (n, total) => {
          toast(total > 1 ? `联合投稿：已拉黑 ${n}/${total} 位作者` : `已拉黑：${targets[0].name || targets[0].uid}`);
          cb && cb(n > 0);
        });
      });
      return;
    }
    if (uid) {
      doBlacklist(uid, upName, cb);
      return;
    }
    if (bvid) {
      toast('正在解析该 UP 的 UID…');
      resolveUidByBvid(bvid, (rid, rname) => {
        if (rid) {
          doBlacklist(rid, rname || upName, cb);
        } else if (upName) {
          addToList(CONFIG.block.upNames, upName);
          toast(`未能解析 UID，已按 UP 名本地屏蔽：${upName}`);
          cb && cb(false);
        } else {
          toast('未能解析该 UP，已跳过');
          cb && cb(false);
        }
      });
      return;
    }
    if (upName) {
      addToList(CONFIG.block.upNames, upName);
      toast(`该卡片没拿到 UID/BV，已按 UP 名本地屏蔽：${upName}`);
    } else {
      toast('该卡片信息不足，无法拉黑');
    }
    cb && cb(false);
  }

  /* ===================== 7. 右键菜单 ===================== */
  let ctxMenuEl = null;
  function closeCtxMenu() {
    if (ctxMenuEl) {
      ctxMenuEl.remove();
      ctxMenuEl = null;
    }
  }
  function onContextMenu(e) {
    if (!CONFIG.enabled || !CONFIG.rightClickBlock) return;

    // 评论区右键（优先于视频卡）：在评论上右键 → 屏蔽该评论用户 / 选中文本加评论关键词
    if (CONFIG.comment.enabled) {
      const cmtHost = findCommentHost(e);
      if (cmtHost) {
        const c = readCmt(cmtHost);
        const citems = [];
        const csel = (window.getSelection && window.getSelection().toString().trim()) || '';
        if (csel && csel.length <= 30) {
          citems.push({
            label: `🚫 评论含「${csel}」关键词`,
            act: () => {
              addToList(CONFIG.comment.keywords, csel);
              toast(`已加入评论关键词：${csel}`);
              refreshPanelIfOpen();
            },
          });
        }
        if (c.uname) {
          citems.push({
            label: `🚫 屏蔽评论用户「${c.uname}」`,
            act: () => {
              addToList(CONFIG.comment.userNames, c.uname);
              toast(`已屏蔽评论用户：${c.uname}`);
              refreshPanelIfOpen();
            },
          });
        }
        if (citems.length) {
          e.preventDefault();
          e.stopPropagation();
          closeCtxMenu();
          renderCtxMenu(e, citems);
          return;
        }
      }
    }

    const card = e.target.closest(VIDEO_CARD_SELECTOR);
    if (!card) return;
    // 右键为低频用户操作：强制深度提取，确保拿到权威 UID（扫描期缓存可能未解析 UID）
    const info = extractCardInfo(card, true);
    if (!info.up && !info.bvid) return;

    e.preventDefault();
    e.stopPropagation();
    closeCtxMenu();

    const items = [];
    const sel = (window.getSelection && window.getSelection().toString().trim()) || '';
    if (sel && sel.length <= 30) {
      items.push({
        label: `🚫 屏蔽含「${sel}」关键词`,
        act: () => {
          addToList(CONFIG.block.keywords, sel);
          toast(`已加入关键词：${sel}`);
          refreshPanelIfOpen();
        },
      });
    }
    if (info.up) {
      items.push({
        label: `🚫 屏蔽UP「${info.up}」`,
        act: () => {
          if (info.uid) addToList(CONFIG.block.uids, info.uid);
          else addToList(CONFIG.block.upNames, info.up);
          toast(`已屏蔽 UP：${info.up}`);
          refreshPanelIfOpen();
        },
      });
      items.push({
        label: `⛔ 拉黑UP「${info.up}」(同步账号黑名单)`,
        act: () => blacklistUp(info, refreshPanelIfOpen, card),
      });
      items.push({
        label: `⭐ 加白名单(永不屏蔽此UP)`,
        act: () => {
          addToList(CONFIG.allow.upNames, info.up);
          toast(`已加入白名单：${info.up}`);
          refreshPanelIfOpen();
        },
      });
    }
    if (info.bvid) {
      items.push({
        label: `🚫 屏蔽此视频 (${info.bvid})`,
        act: () => {
          addToList(CONFIG.block.bvids, info.bvid);
          toast(`已屏蔽视频：${info.bvid}`);
          refreshPanelIfOpen();
        },
      });
    }
    items.push({
      label: '🙈 隐藏这一张',
      act: () => {
        card.setAttribute(PROCESSED, '1');
        blockVideo(card, '手动', info);
      },
    });
    items.push({ label: '⚙️ 打开设置面板', act: openPanel });

    renderCtxMenu(e, items);
  }

  // 在鼠标处弹出自定义菜单（视频卡 / 评论 共用）
  function renderCtxMenu(e, items) {
    const menu = document.createElement('div');
    menu.id = 'bfb-ctxmenu';
    items.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'bfb-ctx-item';
      row.textContent = it.label;
      row.onclick = () => {
        closeCtxMenu();
        it.act();
      };
      menu.appendChild(row);
    });
    document.body.appendChild(menu);
    menu.style.left = Math.min(e.clientX, window.innerWidth - 270) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 10) + 'px';
    ctxMenuEl = menu;
  }

  // 评论在 shadow DOM 内，contextmenu 的 target 会重定向到宿主；用 composedPath 在路径上找评论组件宿主
  function findCommentHost(e) {
    const path = (e.composedPath && e.composedPath()) || [];
    for (const el of path) {
      if (el && el.tagName && CMT_TAGS[el.tagName] !== undefined) return el;
    }
    return null;
  }
  document.addEventListener('click', closeCtxMenu, true);
  document.addEventListener('scroll', closeCtxMenu, true);

  /* —— 悬停快捷拉黑按钮（独立 fixed 浮层，不改 B 站卡片 DOM，规避框架重渲染冲掉） —— */
  // 浮层根：独立 Shadow DOM。host 自身 pointer-events:none + contain，既抗 B 站框架重渲染冲掉，
  // 又让页面 CSS 与我们的样式互不污染（借鉴 codertesla bilibili-1-click-blocker）。
  let overlayHost = null;
  let overlayRoot = null;
  function getOverlayRoot() {
    if (overlayRoot) return overlayRoot;
    overlayHost = document.createElement('div');
    overlayHost.id = 'bfb-overlay-host';
    overlayHost.style.cssText = 'position:fixed;inset:0;z-index:100002;pointer-events:none;contain:layout style';
    overlayRoot = overlayHost.attachShadow({ mode: 'open' });
    const st = document.createElement('style');
    st.textContent =
      '.blk{position:fixed;pointer-events:auto;background:rgba(251,114,153,.95);color:#fff;border-radius:8px;padding:4px 10px;font-size:12px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.28);font-family:system-ui,Arial;user-select:none;display:none}' +
      '.blk:hover{background:#fb7299}';
    overlayRoot.appendChild(st);
    (document.documentElement || document.body).appendChild(overlayHost);
    return overlayRoot;
  }

  let hoverBtn = null;
  let hoverCard = null;
  function ensureHoverBtn() {
    if (hoverBtn) return hoverBtn;
    const root = getOverlayRoot();
    hoverBtn = document.createElement('div');
    hoverBtn.className = 'blk';
    hoverBtn.textContent = '⛔ 拉黑';
    hoverBtn.title = '拉黑该 UP（同步账号黑名单）';
    hoverBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!hoverCard) return;
      const info = hoverCard._bfbInfo || extractCardInfo(hoverCard);
      if (!info.up && !info.bvid) {
        toast('该卡片信息不足，无法拉黑');
        return;
      }
      blacklistUp(info, refreshPanelIfOpen, hoverCard);
      hideHoverBtn();
    };
    root.appendChild(hoverBtn);
    return hoverBtn;
  }
  function hideHoverBtn() {
    if (hoverBtn) hoverBtn.style.display = 'none';
    hoverCard = null;
  }
  function positionHoverBtn(card) {
    const r = card.getBoundingClientRect();
    if (r.width < 80 || r.height < 60) return hideHoverBtn(); // 太小的卡（如纯文本/骨架）不显示
    const b = ensureHoverBtn();
    b.style.left = Math.max(8, r.left + 8) + 'px';
    b.style.top = Math.max(8, r.top + 8) + 'px';
    b.style.display = 'block';
    hoverCard = card;
  }
  function onCardHover(e) {
    if (!CONFIG.enabled || !CONFIG.cardHoverBtn) return;
    const t = e.target;
    if (t === overlayHost) return; // 事件从 Shadow 浮层冒泡时 target 会重定向为 host，保持显示
    const card = t.closest && t.closest(VIDEO_CARD_SELECTOR);
    if (card) {
      if (card !== hoverCard) positionHoverBtn(card);
    } else {
      hideHoverBtn();
    }
  }

  /* ===================== 8. UI 面板 ===================== */
  GM_addStyle(`
    .bfb-review{outline:2px solid #fb7299 !important;outline-offset:-2px;border-radius:8px;position:relative !important}
    .bfb-tag{position:absolute;top:6px;left:6px;z-index:9;display:flex;align-items:center;gap:6px;background:rgba(251,114,153,.95);color:#fff;border-radius:8px;padding:3px 6px;font-size:11px;font-family:system-ui,Arial;box-shadow:0 2px 6px rgba(0,0,0,.25)}
    .bfb-tag .rs{white-space:nowrap;max-width:160px;overflow:hidden;text-overflow:ellipsis}
    .bfb-tag button{border:none;border-radius:6px;background:#fff;color:#1b7a3d;font-size:11px;padding:2px 6px;cursor:pointer;white-space:nowrap}
    #bfb-badge{position:fixed;right:18px;bottom:18px;z-index:99999;background:#fb7299;color:#fff;border-radius:24px;padding:8px 14px;font-size:13px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.2);font-family:system-ui,Arial;user-select:none}
    #bfb-badge.off{background:#999}
    #bfb-ctxmenu{position:fixed;z-index:100002;background:#fff;border:1px solid #ffd5e2;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.22);overflow:hidden;min-width:210px;font-family:system-ui,Arial}
    .bfb-ctx-item{padding:10px 14px;font-size:13px;color:#333;cursor:pointer;white-space:nowrap}
    .bfb-ctx-item:hover{background:#fff0f5;color:#fb7299}
    #bfb-toasts{position:fixed;right:18px;bottom:70px;z-index:100001;display:flex;flex-direction:column}
    .bfb-toast{background:#fff;color:#222;border-radius:12px;padding:12px 14px;font-size:13px;box-shadow:0 6px 24px rgba(0,0,0,.18);max-width:320px;font-family:system-ui,Arial;border:1px solid #ffd5e2;margin-top:8px}
    #bfb-panel{position:fixed;top:0;right:0;width:400px;max-width:94vw;height:100vh;z-index:100000;background:#fff;box-shadow:-4px 0 24px rgba(0,0,0,.2);overflow:auto;overscroll-behavior:contain;font-family:system-ui,Arial;transform:translateX(100%);transition:transform .25s}
    #bfb-panel.open{transform:translateX(0)}
    #bfb-panel h2{margin:0;padding:14px 16px;background:#fb7299;color:#fff;font-size:16px;position:sticky;top:0;display:flex;justify-content:space-between;align-items:center;z-index:2}
    #bfb-panel h2 .x{cursor:pointer}
    #bfb-panel .sec{padding:10px 16px;border-bottom:1px solid #f0f0f0}
    #bfb-panel .sec.allow{background:#f3fbf4}
    #bfb-panel label{font-size:13px;color:#444;display:block;margin-bottom:6px;font-weight:600}
    #bfb-panel .addrow{display:flex;gap:6px}
    #bfb-panel .addrow input{flex:1;min-width:0;padding:6px 8px;border:1px solid #ddd;border-radius:8px;font-size:13px}
    #bfb-panel .addrow button{background:#fb7299;color:#fff;border:none;border-radius:8px;padding:0 14px;cursor:pointer;font-size:13px;white-space:nowrap}
    #bfb-panel .chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
    #bfb-panel .chip{display:inline-flex;align-items:center;gap:6px;background:#fff0f5;color:#c2185b;border:1px solid #ffd5e2;border-radius:14px;padding:3px 10px;font-size:12px}
    #bfb-panel .sec.allow .chip{background:#eafaef;color:#1b7a3d;border-color:#c6ecd0}
    #bfb-panel .chip b{cursor:pointer;font-weight:700;opacity:.6}
    #bfb-panel .chip b:hover{opacity:1}
    #bfb-panel .empty{font-size:11px;color:#bbb;margin-top:6px}
    #bfb-panel input[type=number]{width:80px;padding:4px 6px;border:1px solid #ddd;border-radius:6px}
    #bfb-panel .hint{font-size:11px;color:#999;margin-top:4px}
    #bfb-panel .toolbar{display:flex;gap:8px;flex-wrap:wrap}
    #bfb-panel button.act{background:#fb7299;color:#fff;border:none;border-radius:8px;padding:8px 12px;cursor:pointer;font-size:13px}
    #bfb-panel button.ghost{background:#f3f3f3;color:#333}
    #bfb-panel .switch{display:flex;align-items:center;gap:8px;font-size:13px;color:#333;font-weight:600;margin-top:6px}
    #bfb-panel .stat{font-size:12px;color:#888}
    #bfb-panel a.manage{color:#fb7299;font-size:12px}
    #bfb-panel .sec.api{background:#f5f3ff}
    /* —— 交互美化 —— */
    #bfb-panel h2{background:linear-gradient(135deg,#fb7299,#ff9bb6)}
    #bfb-panel .switch input[type=checkbox]{appearance:none;-webkit-appearance:none;width:38px;height:22px;border-radius:22px;background:#d4d4d8;position:relative;cursor:pointer;transition:.2s;flex:0 0 auto;margin:0}
    #bfb-panel .switch input[type=checkbox]:checked{background:#fb7299}
    #bfb-panel .switch input[type=checkbox]::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:.2s;box-shadow:0 1px 3px rgba(0,0,0,.3)}
    #bfb-panel .switch input[type=checkbox]:checked::after{transform:translateX(16px)}
    #bfb-panel .sec{transition:background .15s}
    #bfb-panel .addrow input:focus,#bfb-panel input[type=number]:focus{outline:none;border-color:#fb7299;box-shadow:0 0 0 2px rgba(251,114,153,.18)}
    #bfb-panel button.act:active,#bfb-panel .addrow button:active{transform:translateY(1px)}
    #bfb-panel::-webkit-scrollbar{width:10px}
    #bfb-panel::-webkit-scrollbar-thumb{background:#f0c2d2;border-radius:8px;border:2px solid #fff}
    #bfb-panel::-webkit-scrollbar-thumb:hover{background:#fb7299}
    #bfb-panel .chip{transition:transform .1s}
    #bfb-panel .chip:hover{transform:translateY(-1px)}
    #bfb-panel .field-head{cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px;margin-bottom:0;padding:4px 6px;margin-left:-6px;margin-right:-6px;border-radius:8px;transition:background .12s}
    #bfb-panel .field-head:hover{background:#fff0f5}
    #bfb-panel .field-head .caret{color:#fb7299;font-size:14px;width:14px;flex:0 0 auto;transition:transform .12s}
    #bfb-panel .chip-bar{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
    #bfb-panel .chip-act{border:1px solid #ffd5e2;background:#fff;color:#fb7299;border-radius:8px;padding:3px 10px;font-size:12px;cursor:pointer}
    #bfb-panel .chip-act:hover{background:#fff0f5}
    #bfb-panel .chip-act.primary{background:#fb7299;color:#fff;border-color:#fb7299}
    #bfb-panel .chip.sel{outline:2px solid #fb7299;outline-offset:1px;background:#ffd9e6}
    #bfb-panel .sec.allow .chip.sel{outline-color:#1b7a3d;background:#cdeed6}
    #bfb-panel .log-row{display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid rgba(128,128,128,.12)}
    #bfb-panel .log-tx{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #bfb-panel .log-rs{color:#fb7299;margin-right:2px}
    #bfb-panel .log-src{flex:0 0 auto;font-size:10px;border-radius:5px;padding:0 4px;margin-right:4px;color:#fff}
    #bfb-panel .log-src.net{background:#27ae60}
    #bfb-panel .log-src.dom{background:#e67e22}
    #bfb-panel .log-blk{flex:0 0 auto;border:1px solid #ffd5e2;background:#fff;color:#fb7299;border-radius:7px;padding:2px 8px;font-size:11px;cursor:pointer}
    #bfb-panel .log-blk:hover{background:#fb7299;color:#fff}
    #bfb-panel .log-blk[disabled]{opacity:.6;cursor:default}
    #bfb-panel .log-pass{flex:0 0 auto;border:1px solid #c6ecd0;background:#fff;color:#1b7a3d;border-radius:7px;padding:2px 8px;font-size:11px;cursor:pointer;margin-right:6px}
    #bfb-panel .log-pass:hover{background:#1b7a3d;color:#fff}
    #bfb-panel .field-head .lt{flex:1}
    #bfb-panel .field-head .cnt{background:#fb7299;color:#fff;border-radius:10px;font-size:11px;padding:0 7px;min-width:18px;text-align:center;font-weight:700}
    #bfb-panel .field-head .cnt:empty{display:none}
    #bfb-panel .field-body{margin-top:8px}
    #bfb-panel .field .chips{max-height:132px;overflow-y:auto;overscroll-behavior:contain;background:#fafafa;border:1px solid #eee;border-radius:10px;padding:8px;margin-top:8px}
    #bfb-panel .field .chips:empty{display:none}
    #bfb-panel .field .chips::-webkit-scrollbar{width:8px}
    #bfb-panel .field .chips::-webkit-scrollbar-thumb{background:#f0c2d2;border-radius:8px}
    #bfb-panel .field .chips::-webkit-scrollbar-thumb:hover{background:#fb7299}
    #bfb-panel .chip.uidchip::before{content:"账号";font-size:9px;background:#6b4dff;color:#fff;border-radius:5px;padding:0 4px;margin-right:2px}
    #bfb-panel .chip.group{background:#ede9fe;color:#5b21b6;border-color:#ddd6fe}
    /* —— 分组 Tab —— */
    #bfb-panel .tabs{position:sticky;top:48px;z-index:2;display:flex;flex-wrap:wrap;justify-content:center;gap:6px;padding:10px 12px;background:#fff;border-bottom:1px solid #f0f0f0;overscroll-behavior:contain}
    #bfb-panel .tab{flex:0 0 auto;padding:6px 13px;border-radius:16px;background:#f3f3f3;color:#666;font-size:13px;cursor:pointer;border:none;white-space:nowrap;font-weight:600;transition:.15s}
    #bfb-panel .tab:hover{background:#ffe3ec;color:#fb7299}
    #bfb-panel .tab.active{background:linear-gradient(135deg,#fb7299,#ff9bb6);color:#fff;box-shadow:0 2px 8px rgba(251,114,153,.35)}
    #bfb-panel .bfb-group{display:none}
    #bfb-panel .bfb-group.active{display:block;animation:bfb-fade .18s ease}
    @keyframes bfb-fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
    #bfb-panel .grp-tip{padding:8px 16px;font-size:11px;color:#aaa;background:#fafafa;border-bottom:1px solid #f0f0f0}
  `);

  function updateBadge() {
    let b = document.getElementById('bfb-badge');
    if (!b) {
      b = document.createElement('div');
      b.id = 'bfb-badge';
      b.title = '点击打开设置';
      b.onclick = openPanel;
      document.body.appendChild(b);
    }
    b.classList.toggle('off', !CONFIG.enabled);
    b.textContent = CONFIG.enabled ? `🛡 已拦截 ${sessionBlocked}（共${CONFIG.blockedCount}）` : '🛡 已暂停';
  }

  function toastContainer() {
    let c = document.getElementById('bfb-toasts');
    if (!c) {
      c = document.createElement('div');
      c.id = 'bfb-toasts';
      document.body.appendChild(c);
    }
    return c;
  }
  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'bfb-toast';
    t.textContent = msg;
    toastContainer().appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }

  // 记住每个字段的折叠状态（renderPanel 重建时保留）
  const collapseState = {};
  // 记住当前激活的分组 Tab（renderPanel 重建时保留）
  let activeTab = 'base';

  // —— 通用列表字段组件 —— 折叠头 / 添加行 / 批量管理 / chip 渲染 共一套；
  // 不同字段（关键词、UP名+UID、组合标签…）只需提供一个轻量 model 适配器。
  function renderListField(host, o) {
    const model = o.model;
    const el = (t, c) => {
      const e = document.createElement(t);
      if (c) e.className = c;
      return e;
    };
    const sec = el('div', 'sec field' + (o.isAllow ? ' allow' : ''));
    const lab = el('label', 'field-head');
    const collapsed = !!collapseState[o.label];
    lab.innerHTML = `<span class="caret">${collapsed ? '▸' : '▾'}</span> <span class="lt">${o.label}</span> <span class="cnt">${model.count() || ''}</span>`;
    sec.appendChild(lab);
    const body = el('div', 'field-body');
    body.style.display = collapsed ? 'none' : 'block';
    sec.appendChild(body);
    lab.onclick = () => {
      const now = body.style.display === 'none';
      body.style.display = now ? 'block' : 'none';
      collapseState[o.label] = !now;
      lab.querySelector('.caret').textContent = now ? '▾' : '▸';
    };
    const addrow = el('div', 'addrow');
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = o.placeholder || '输入后点添加';
    if (o.inputTitle) input.title = o.inputTitle;
    const btn = document.createElement('button');
    btn.textContent = '添加';
    addrow.appendChild(input);
    addrow.appendChild(btn);
    body.appendChild(addrow);
    if (o.hint) {
      const h = el('div', 'hint');
      h.style.marginTop = '6px';
      h.textContent = o.hint;
      body.appendChild(h);
    }
    const bar = el('div', 'chip-bar');
    body.appendChild(bar);
    const chips = el('div', 'chips');
    body.appendChild(chips);

    let manage = false;
    const selected = new Set();
    const renderBar = () => {
      bar.innerHTML = '';
      if (!model.count()) {
        manage = false;
        return;
      }
      const mk = (text, fn, primary) => {
        const b = el('button', 'chip-act' + (primary ? ' primary' : ''));
        b.textContent = text;
        b.onclick = fn;
        bar.appendChild(b);
      };
      if (!manage) {
        mk('批量管理', () => {
          manage = true;
          selected.clear();
          renderChips();
        });
        return;
      }
      mk('全选', () => {
        model.entries().forEach((e) => selected.add(e.key));
        renderChips();
      });
      mk('反选', () => {
        model.entries().forEach((e) => (selected.has(e.key) ? selected.delete(e.key) : selected.add(e.key)));
        renderChips();
      });
      mk(`删除所选(${selected.size})`, () => {
        if (!selected.size) {
          toast('未勾选任何项');
          return;
        }
        const n = selected.size;
        const byKey = {};
        model.entries().forEach((e) => (byKey[e.key] = e));
        selected.forEach((k) => byKey[k] && removeFromList(byKey[k].arr, byKey[k].value));
        selected.clear();
        renderChips();
        toast(`已删除 ${n} 条`);
      }, true);
      mk('清空', () => {
        if (model.count() && confirm(`确定清空该列表全部 ${model.count()} 条？`)) {
          model.clear();
          selected.clear();
          renderChips();
        }
      });
      mk('完成', () => {
        manage = false;
        selected.clear();
        renderChips();
      });
    };
    const renderChips = () => {
      chips.innerHTML = '';
      lab.querySelector('.cnt').textContent = model.count() || '';
      if (!model.count()) {
        const e = el('div', 'empty');
        e.textContent = '（暂无，添加后会显示在这里）';
        chips.appendChild(e);
        renderBar();
        return;
      }
      model.entries().forEach((entry) => {
        const chip = el('span', 'chip' + (manage && selected.has(entry.key) ? ' sel' : ''));
        const txt = document.createElement('span');
        model.decorate(entry, chip, txt, renderChips);
        chip.appendChild(txt);
        if (manage) {
          chip.style.cursor = 'pointer';
          chip.title = '点击勾选 / 取消';
          chip.onclick = () => {
            if (selected.has(entry.key)) selected.delete(entry.key);
            else selected.add(entry.key);
            renderChips();
          };
        } else {
          const x = document.createElement('b');
          x.textContent = '✕';
          x.title = '删除';
          x.onclick = () => {
            removeFromList(entry.arr, entry.value);
            renderChips();
          };
          chip.appendChild(x);
        }
        chips.appendChild(chip);
      });
      renderBar();
    };
    const doAdd = () => {
      if (model.add(input.value)) {
        input.value = '';
        renderChips();
      }
    };
    btn.onclick = doAdd;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doAdd();
    });
    renderChips();
    host.appendChild(sec);
  }

  // 把多条输入拆成规则数组（正则感知）：换行总是分隔；以 / 开头的行视为整条正则、不按逗号拆
  // （避免把 /震惊{2,3}/、/(a|b){1,2}/ 这类含逗号的正则拆断）；其余行才按 逗号/分号 拆。
  function splitRuleInput(raw) {
    const out = [];
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

  // 普通 chip 列表（关键词 / BV / 标签 / 白名单…）；groupMode=组合标签
  function chipModel(arr, groupMode) {
    return {
      count: () => arr.length,
      entries: () => arr.map((v) => ({ key: v, value: v, arr })),
      clear: () => {
        arr.length = 0;
      },
      add: (raw) => {
        if (groupMode) {
          const parts = raw.split(/[+,，、\s]+/).map((s) => s.trim()).filter(Boolean);
          if (parts.length < 2) {
            toast('组合标签至少要 2 个，如：原神 鸣潮');
            return false;
          }
          if (addToList(arr, parts.join('+'))) {
            toast(`已添加组合：${parts.join(' & ')}`);
            return true;
          }
          toast('该组合已存在');
          return false;
        }
        const parts = splitRuleInput(raw);
        if (!parts.length) return false;
        let added = 0;
        for (const v of parts) if (addToList(arr, v)) added++;
        if (added) toast(`已添加 ${added} 条${parts.length > added ? `（${parts.length - added} 条已存在）` : ''}`);
        else toast('均已存在，未重复添加');
        return true;
      },
      decorate: (entry, chip, txt) => {
        if (groupMode) chip.classList.add('group');
        txt.textContent = groupMode ? String(entry.value).split('+').join(' & ') : entry.value;
      },
    };
  }

  // 「UP 名 + UID」合一：纯数字→uids，否则→names；UID chip 异步解析显示名
  function upModel(names, uids) {
    return {
      count: () => names.length + uids.length,
      entries: () =>
        names
          .map((v) => ({ key: 'n:' + v, value: v, arr: names, uid: false }))
          .concat(uids.map((v) => ({ key: 'u:' + v, value: v, arr: uids, uid: true }))),
      clear: () => {
        names.length = 0;
        uids.length = 0;
      },
      add: (raw) => {
        const parts = splitRuleInput(raw);
        if (!parts.length) return false;
        let added = 0;
        for (const v of parts) if (addToList(/^\d+$/.test(v) ? uids : names, v)) added++;
        toast(added ? `已添加 ${added} 条` : '均已存在，未重复添加');
        return true;
      },
      decorate: (entry, chip, txt, rerender) => {
        if (!entry.uid) {
          txt.textContent = entry.value;
          return;
        }
        const nm = CONFIG.uidNames[String(entry.value)];
        txt.textContent = nm || entry.value;
        chip.classList.add('uidchip');
        chip.title = 'UID ' + entry.value + (nm ? '' : '（正在解析名称…）');
        if (!nm) {
          fetchCard(entry.value, (d) => {
            const name = d && d.card && d.card.name;
            if (name) {
              CONFIG.uidNames[String(entry.value)] = name;
              saveConfig();
              rerender();
            }
          });
        }
      },
    };
  }

  // 通用控件绑定器：把「读配置 → 回填控件」与「控件变更 → 存盘 + 回调」收敛到一处。
  // 支持 checkbox / select / number。obj 为目标对象（CONFIG 或 CONFIG.block）。
  function bindControl(root, id, obj, key, opts) {
    opts = opts || {};
    const el = root.querySelector('#' + id);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = !!obj[key];
    else el.value = obj[key] != null ? obj[key] : opts.number ? 0 : '';
    el.onchange = () => {
      let v;
      if (el.type === 'checkbox') v = el.checked;
      else if (opts.number) v = (opts.int ? parseInt(el.value, 10) : parseFloat(el.value)) || 0;
      else v = el.value;
      obj[key] = v;
      saveConfig();
      if (opts.after) opts.after();
    };
  }

  // 按描述表渲染一组「列表型」字段（黑/白名单等），新增过滤项 = 表里加一行
  function renderFields(host, defs) {
    defs.forEach((f) => {
      if (f.kind === 'up') {
        renderListField(host, {
          label: f.label,
          hint: f.hint,
          placeholder: '输入 UP 名 或 UID（纯数字自动识别）',
          inputTitle: '可一次粘贴多条，用逗号或换行分隔；纯数字按 UID，其余按 UP 名',
          model: upModel(CONFIG.block.upNames, CONFIG.block.uids),
        });
        return;
      }
      const arr = (f.scope === 'allow' ? CONFIG.allow : CONFIG.block)[f.key];
      renderListField(host, {
        label: f.label,
        hint: f.hint,
        placeholder: f.placeholder,
        isAllow: f.scope === 'allow',
        inputTitle: f.groupMode ? '输入一组标签，用空格或逗号分隔，表示同时含这些标签才拦' : '可一次粘贴多条，用逗号或换行分隔',
        model: chipModel(arr, f.groupMode),
      });
    });
  }

  function buildPanel() {
    if (panelEl()) return;
    const p = document.createElement('div');
    p.id = 'bfb-panel';
    // 拦住面板输入框的键盘事件，别冒泡到 B 站全局「按键即搜索」快捷键
    ['keydown', 'keypress', 'keyup', 'input'].forEach((ev) => {
      p.addEventListener(ev, (e) => {
        if (e.target && e.target.matches && e.target.matches('input, textarea, select')) e.stopPropagation();
      });
    });
    document.body.appendChild(p);
    renderPanel(p);
  }

  // 顶部分组 Tab：把杂乱的长列表归类成「基础 / 黑名单 / 进阶 / 白名单 / 工具」
  const PANEL_TABS = [
    ['base', '⚙ 基础', '常规开关与卡片类型过滤'],
    ['black', '🚫 黑名单', '按标题 / UP主 / 分区屏蔽，即时生效。规则用 /.../ 包裹表示正则（如 /震惊.*竟然/），否则按关键词包含匹配（不分大小写）'],
    ['api', '🛰 进阶', '播放量、时长，以及标签 / 数据等更细致的过滤（标签类需开启下方的「精确过滤」）'],
    ['comment', '💬 评论', '过滤视频/动态评论区的引战、水军、营销与 AI 评论（读评论数据隐藏，仅在有评论的页面生效；与视频规则相互独立）'],
    ['allow', '⭐ 白名单', '命中白名单的内容永不隐藏，优先级最高'],
    ['tools', '🧰 工具', '预置库 / 重置 / 屏蔽记录'],
  ];

  // 列表型字段描述表：黑名单 / 进阶标签 / 白名单。新增一类过滤只需在此加一行。
  const BLACK_FIELDS = [
    { key: 'keywords', label: '🎯 关键词', placeholder: '如：原神 或 /震惊.*竟然/', hint: '一次命中 标题 / UP主名 / 分区（纯本地、免联网）。普通词=包含即拦；/.../ 包裹=正则，如 /一口气.*看完/。可加作用域前缀只匹配某字段：title:词 / up:词 / part:词（如 up:营销号 只按 UP 名拦）。想按视频标签拦截请用下方「视频标签」（需开精确过滤）。' },
    { kind: 'up', label: 'UP 主', hint: '输入 UP 名 或 UID（纯数字自动识别为 UID）；可一次粘贴多条，用逗号或换行分隔。' },
    { key: 'bvids', label: 'BV 号', placeholder: '如：BV1xx411c7XX', hint: '按视频 BV 号精确屏蔽单个视频。' },
    { key: 'partitions', label: '视频分区', placeholder: '如：资讯 或 /综艺|娱乐/', hint: '按视频分区(tname)屏蔽，网络拦截层最准。普通词=包含即拦；/.../ 包裹=正则。' },
  ];
  const API_CHIP_FIELDS = [
    { key: 'tags', label: '视频标签', placeholder: '如：原神 或 /鬼畜|二创/', hint: '匹配视频的完整标签(tag)，需开启上方「精确过滤」。普通词=包含即拦；/.../ 包裹=正则。' },
    { key: 'dualTags', label: '组合标签', placeholder: '如：原神 鸣潮（空格分隔）', groupMode: true, hint: '同时含这一组里所有标签才屏蔽，专治对立引战内容；需开启「精确过滤」。' },
    { key: 'upBio', label: 'UP 简介关键词', placeholder: '如：商务合作', hint: '匹配 UP 主个人简介，需开启「精确过滤」。' },
  ];
  const ALLOW_FIELDS = [
    { scope: 'allow', key: 'keywords', label: '关键词', placeholder: '喜欢的题材', hint: '命中即永不隐藏（优先级最高）。作用于 视频标题 与 UP 主名；普通词=包含，/.../ =正则。' },
    { scope: 'allow', key: 'upNames', label: 'UP 主名', placeholder: '喜欢的 UP 主名', hint: '该 UP 的视频永不隐藏（按名称精确匹配）。' },
    { scope: 'allow', key: 'uids', label: 'UID', placeholder: '喜欢的 UP 的 UID（纯数字）', hint: '该 UP 的视频永不隐藏（按 UID 精确匹配，最可靠）。' },
  ];

  function renderPanel(p) {
    p.innerHTML = '';
    panelStatsRefresh = null;
    const h2 = document.createElement('h2');
    h2.innerHTML = `🛡 biliHoyoFairy · 抗击黑潮 <small style="font-weight:normal;opacity:.6;font-size:12px">v${VERSION} · ${pageType()}</small> <span class="x">✕</span>`;
    p.appendChild(h2);
    h2.querySelector('.x').onclick = closePanel;

    // —— Tab 条 + 各分组容器（一次性全部渲染，切 Tab 只切显隐，保证绑定与记录刷新始终有效）——
    const tabBar = document.createElement('div');
    tabBar.className = 'tabs';
    p.appendChild(tabBar);
    if (!PANEL_TABS.some(([id]) => id === activeTab)) activeTab = 'base';
    const G = {};
    PANEL_TABS.forEach(([id, label, tip]) => {
      const tb = document.createElement('button');
      tb.className = 'tab' + (id === activeTab ? ' active' : '');
      tb.textContent = label;
      tabBar.appendChild(tb);
      const g = document.createElement('div');
      g.className = 'bfb-group' + (id === activeTab ? ' active' : '');
      const tipEl = document.createElement('div');
      tipEl.className = 'grp-tip';
      tipEl.textContent = tip;
      g.appendChild(tipEl);
      p.appendChild(g);
      G[id] = g;
      tb.onclick = () => {
        activeTab = id;
        tabBar.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
        tb.classList.add('active');
        Object.values(G).forEach((x) => x.classList.remove('active'));
        g.classList.add('active');
        p.scrollTop = 0;
      };
    });

    const sw = document.createElement('div');
    sw.className = 'sec';
    sw.innerHTML = `
      <div class="switch"><input type="checkbox" id="bfb-enabled"> 启用拦截</div>
      <div class="switch"><input type="checkbox" id="bfb-review"> 🔍 审查模式（不隐藏，标记被拦视频+就地放行，便于核对）</div>
      <div class="switch"><input type="checkbox" id="bfb-rclick"> 右键卡片弹菜单（屏蔽/拉黑/加白名单）</div>
      <div class="switch"><input type="checkbox" id="bfb-hoverbtn"> 悬停卡片显示快捷「拉黑」按钮</div>
      <div class="switch"><input type="checkbox" id="bfb-collab"> 联合投稿一并拉黑合作者</div>
      <div class="switch"><input type="checkbox" id="bfb-fuzzy"> 反绕过模糊匹配（"原 神 / 原.神" 也拦；隐形字符始终拦）</div>
      <div class="switch"><input type="checkbox" id="bfb-debug"> 调试模式（控制台逐卡打印拦/放原因）</div>
      <div class="hint">所有开关与规则均<b>即时生效</b>，无需保存。<b>审查模式</b>切换后建议<b>刷新页面</b>以核对完整结果。真正“从推荐流消失”请用<b>拉黑</b>。</div>`;
    G.base.appendChild(sw);
    bindControl(sw, 'bfb-enabled', CONFIG, 'enabled', {
      after: () => {
        updateBadge();
        rescanAfterRuleChange();
      },
    });
    bindControl(sw, 'bfb-review', CONFIG, 'reviewMode', { after: rescanAfterRuleChange });
    bindControl(sw, 'bfb-rclick', CONFIG, 'rightClickBlock');
    bindControl(sw, 'bfb-hoverbtn', CONFIG, 'cardHoverBtn', { after: hideHoverBtn });
    bindControl(sw, 'bfb-collab', CONFIG, 'blacklistCollab');
    bindControl(sw, 'bfb-fuzzy', CONFIG, 'fuzzyMatch', { after: rescanAfterRuleChange });
    bindControl(sw, 'bfb-debug', CONFIG, 'debug', { after: rescanAfterRuleChange });

    const ct = document.createElement('div');
    ct.className = 'sec';
    ct.innerHTML = `
      <label>卡片类型过滤</label>
      <div class="switch"><input type="checkbox" id="bfb-ad"> 屏蔽广告/推广卡片</div>
      <div class="switch"><input type="checkbox" id="bfb-live"> 屏蔽信息流里的直播推荐卡</div>
      <div class="switch"><input type="checkbox" id="bfb-hotsearch"> 屏蔽搜索框热搜词</div>
      <div class="hint">广告为自动识别，偶有误差；可在下方「屏蔽记录」核对实际拦了什么。直播卡=首页/动态里链向直播间的推荐卡。</div>`;
    G.base.appendChild(ct);
    bindControl(ct, 'bfb-ad', CONFIG, 'hideAd', { after: rescanAfterRuleChange });
    bindControl(ct, 'bfb-live', CONFIG, 'hideLiveCard', { after: rescanAfterRuleChange });
    bindControl(ct, 'bfb-hotsearch', CONFIG, 'hideHotSearch', { after: applyHotSearchStyle });

    renderFields(G.black, BLACK_FIELDS);

    // 进阶页：播放量 / 时长（本地数值阈值，即时生效）
    const num = document.createElement('div');
    num.className = 'sec';
    num.innerHTML = `<label>播放量 / 时长</label>
      <div class="switch" style="margin-top:4px;font-weight:400">播放量低于 <input type="number" id="bfb-minviews" min="0" step="0.1" style="width:64px"> 万则屏蔽（0=不启用）</div>
      <div class="switch" style="margin-top:8px;font-weight:400">时长　最短 <input type="number" id="bfb-dmin" min="0" style="width:64px"> 秒　最长 <input type="number" id="bfb-dmax" min="0" style="width:64px"> 秒</div>
      <div class="switch" style="margin-top:8px;font-weight:400">营销号：点赞率低于 <input type="number" id="bfb-spamratio" min="0" max="100" step="0.1" style="width:56px"> % 且播放≥ <input type="number" id="bfb-spamviews" min="0" step="1" style="width:56px"> 万 则屏蔽</div>
      <div class="hint">填 0 表示该项不启用。营销号/搬运号常"高播放、极低赞"。⚠ 点赞率<b>仅在接口返回点赞数时生效（主要是首页推荐流）</b>；拿不到点赞数的卡片（部分 SSR / 动态）会跳过此项，不影响其它规则。</div>`;
    G.api.appendChild(num);
    bindControl(num, 'bfb-minviews', CONFIG.block, 'minViews', { number: true, after: rescanAfterRuleChange });
    bindControl(num, 'bfb-dmin', CONFIG.block, 'minDuration', { number: true, int: true, after: rescanAfterRuleChange });
    bindControl(num, 'bfb-dmax', CONFIG.block, 'maxDuration', { number: true, int: true, after: rescanAfterRuleChange });
    bindControl(num, 'bfb-spamratio', CONFIG.block, 'spamLikeRatio', { number: true, after: rescanAfterRuleChange });
    bindControl(num, 'bfb-spamviews', CONFIG.block, 'spamMinViews', { number: true, int: true, after: rescanAfterRuleChange });

    const feed = document.createElement('div');
    feed.className = 'sec';
    feed.innerHTML = `<label>信息流加载</label>
      <div class="switch"><input type="checkbox" id="bfb-boost"> 增大首页推荐每批加载数量</div>
      <div class="hint">拦截层会删掉命中项，开启后让每批多取一些视频，删后信息流更饱满。下次加载 / 刷新生效；个别情况下可能影响载入，异常就关掉。</div>`;
    G.api.appendChild(feed);
    bindControl(feed, 'bfb-boost', CONFIG, 'boostFeedLoad');

    const api = document.createElement('div');
    api.className = 'sec api';
    api.innerHTML = `
      <label>🛰 精确过滤</label>
      <div class="switch"><input type="checkbox" id="bfb-api"> <b>启用精确过滤</b></div>
      <div class="hint">开启后会按需读取视频标签、UP 简介等数据来判断，命中时卡片会略有延迟才被隐藏；不开启则完全不联网。</div>
      <div id="bfb-api-body" style="margin-top:6px">
        <div class="switch"><input type="checkbox" id="bfb-charging"> 屏蔽充电专属视频</div>
      </div>`;
    G.api.appendChild(api);
    const apiBody = api.querySelector('#bfb-api-body');
    const syncApiBody = () => {
      apiBody.style.opacity = CONFIG.apiFilters ? '1' : '.4';
      apiBody.style.pointerEvents = CONFIG.apiFilters ? 'auto' : 'none';
    };
    bindControl(api, 'bfb-api', CONFIG, 'apiFilters', {
      after: () => {
        syncApiBody();
        rescanAfterRuleChange();
      },
    });
    bindControl(api, 'bfb-charging', CONFIG, 'hideCharging', { after: rescanAfterRuleChange });
    syncApiBody();
    renderFields(G.api, API_CHIP_FIELDS);

    // —— 评论区分组 ——
    const cmt = document.createElement('div');
    cmt.className = 'sec';
    cmt.innerHTML = `
      <label>💬 评论区过滤</label>
      <div class="switch"><input type="checkbox" id="bfb-cmt"> <b>启用评论区过滤</b></div>
      <div class="hint">读取评论数据后隐藏命中的评论，仅在有评论的页面（播放页 / 动态 / 空间等）生效。下面规则与视频黑名单互相独立。</div>
      <div id="bfb-cmt-body" style="margin-top:6px">
        <div class="switch" style="font-weight:400">评论者等级低于 <input type="number" id="bfb-cmt-level" min="0" max="6" style="width:56px"> 级则隐藏（0=不启用）</div>
        <div class="switch"><input type="checkbox" id="bfb-cmt-noface"> 隐藏 默认头像且非会员（疑似小号/水军）</div>
        <div class="switch"><input type="checkbox" id="bfb-cmt-bot"> 隐藏 AI 机器人发布的评论</div>
        <div class="switch"><input type="checkbox" id="bfb-cmt-callbot"> 隐藏 召唤 AI 的评论</div>
        <div class="switch"><input type="checkbox" id="bfb-cmt-ad"> 隐藏 带货 / 导流广告评论</div>
        <div class="switch"><input type="checkbox" id="bfb-cmt-callonly"> 隐藏 只含 @他人 的空评论</div>
        <div class="switch"><input type="checkbox" id="bfb-cmt-emoji"> 隐藏 纯表情评论</div>
        <div class="switch"><input type="checkbox" id="bfb-cmt-collapse"> 命中后折叠为一行（点击展开），而非直接隐藏</div>
        <label style="margin-top:10px">⭐ 免过滤（白名单）</label>
        <div class="switch"><input type="checkbox" id="bfb-cmt-up"> UP 主的评论</div>
        <div class="switch"><input type="checkbox" id="bfb-cmt-pin"> 置顶评论</div>
        <div class="switch"><input type="checkbox" id="bfb-cmt-me"> 我自己 / @我 的评论</div>
      </div>`;
    G.comment.appendChild(cmt);
    const cmtBody = cmt.querySelector('#bfb-cmt-body');
    const syncCmtBody = () => {
      cmtBody.style.opacity = CONFIG.comment.enabled ? '1' : '.4';
      cmtBody.style.pointerEvents = CONFIG.comment.enabled ? 'auto' : 'none';
    };
    bindControl(cmt, 'bfb-cmt', CONFIG.comment, 'enabled', {
      after: () => {
        syncCmtBody();
        rescanAfterRuleChange();
      },
    });
    bindControl(cmt, 'bfb-cmt-level', CONFIG.comment, 'minLevel', { number: true, int: true, after: rescanAfterRuleChange });
    bindControl(cmt, 'bfb-cmt-noface', CONFIG.comment, 'hideNoFace', { after: rescanAfterRuleChange });
    bindControl(cmt, 'bfb-cmt-bot', CONFIG.comment, 'hideBot', { after: rescanAfterRuleChange });
    bindControl(cmt, 'bfb-cmt-callbot', CONFIG.comment, 'hideCallBot', { after: rescanAfterRuleChange });
    bindControl(cmt, 'bfb-cmt-ad', CONFIG.comment, 'hideAd', { after: rescanAfterRuleChange });
    bindControl(cmt, 'bfb-cmt-callonly', CONFIG.comment, 'hideCallOnly', { after: rescanAfterRuleChange });
    bindControl(cmt, 'bfb-cmt-emoji', CONFIG.comment, 'hideEmojiOnly', { after: rescanAfterRuleChange });
    bindControl(cmt, 'bfb-cmt-collapse', CONFIG.comment, 'collapse', { after: rescanAfterRuleChange });
    bindControl(cmt, 'bfb-cmt-up', CONFIG.comment, 'allowUp', { after: rescanAfterRuleChange });
    bindControl(cmt, 'bfb-cmt-pin', CONFIG.comment, 'allowPin', { after: rescanAfterRuleChange });
    bindControl(cmt, 'bfb-cmt-me', CONFIG.comment, 'allowMe', { after: rescanAfterRuleChange });
    syncCmtBody();
    renderListField(G.comment, {
      label: '🚫 评论关键词',
      placeholder: '如：引战词 或 /.../　',
      hint: '评论正文命中即隐藏。普通词=包含；/.../ =正则。与视频关键词相互独立。',
      model: chipModel(CONFIG.comment.keywords),
    });
    renderListField(G.comment, {
      label: '🚫 评论用户名（精确）',
      placeholder: '精确用户名',
      hint: '按评论者用户名精确隐藏其评论。可在评论区右键用户名快捷加入。',
      model: chipModel(CONFIG.comment.userNames),
    });
    renderListField(G.comment, {
      label: '🚫 用户名关键词',
      placeholder: '如：营销 或 /.../',
      hint: '按评论者昵称关键词隐藏。普通词=包含；/.../ =正则。',
      model: chipModel(CONFIG.comment.userNameKeywords),
    });

    renderFields(G.allow, ALLOW_FIELDS);

    const preset = document.createElement('div');
    preset.className = 'sec';
    preset.innerHTML =
      '<label>预置规则库（点一下加入对应黑名单，可叠加）</label>' +
      '<div class="hint">这只是「一键灌词」入口，本身不是规则；点完后真正生效的规则在「黑名单」页可增删。需要持续更新的大名单请用「规则订阅」。</div>' +
      '<div id="bfb-presets"></div>';
    G.tools.appendChild(preset);
    const presetBox = preset.querySelector('#bfb-presets');
    // 应用一条预置：把 rules 各维度去重加进 CONFIG.block，最后统一存盘+重扫（避免逐条重扫）
    const applyPreset = (p2) => {
      let n = 0;
      for (const dim of Object.keys(p2.rules || {})) {
        const arr = CONFIG.block[dim];
        if (!Array.isArray(arr)) continue;
        for (const v of p2.rules[dim]) {
          const s = String(v).trim();
          if (s && !arr.map(String).includes(s)) {
            arr.push(s);
            n++;
          }
        }
      }
      if (n) {
        saveConfig();
        rescanAfterRuleChange();
      }
      toast(n ? `已加入「${p2.name}」${n} 条` : `「${p2.name}」已全部存在`);
      // 含需联网维度（标签 / 组合标签 / UP简介）的预置，未开「精确过滤」则静默失效——显式引导开启
      const API_DIM_KEYS = ['tags', 'dualTags', 'upBio'];
      const needsApi = Object.keys(p2.rules || {}).some((d) => API_DIM_KEYS.includes(d));
      if (needsApi && !CONFIG.apiFilters && confirm(`「${p2.name}」含需联网读取（标签 / 简介）的规则，必须开启「精确过滤」才会生效。是否现在开启？`)) {
        CONFIG.apiFilters = true;
        saveConfig();
        rescanAfterRuleChange();
      }
      renderPanel(p);
      p.classList.add('open');
    };
    // 按大类分组渲染
    const byCat = {};
    PRESET_LIBRARY.forEach((pp) => (byCat[pp.cat] = byCat[pp.cat] || []).push(pp));
    Object.keys(byCat).forEach((cat) => {
      const cl = document.createElement('div');
      cl.style.cssText = 'font-size:12px;color:#888;margin:8px 0 4px';
      cl.textContent = cat;
      presetBox.appendChild(cl);
      const bar = document.createElement('div');
      bar.className = 'toolbar';
      byCat[cat].forEach((pp) => {
        const btn = document.createElement('button');
        btn.className = 'act ghost';
        btn.textContent = '+ ' + pp.name;
        if (pp.desc) btn.title = pp.desc;
        btn.onclick = () => applyPreset(pp);
        bar.appendChild(btn);
      });
      presetBox.appendChild(bar);
    });

    // —— 正则测试器（仅调试，不影响规则）——
    const retest = document.createElement('div');
    retest.className = 'sec';
    retest.innerHTML = `<label>🧪 正则测试器（仅调试用，不影响规则）</label>
      <div class="addrow"><input type="text" id="bfb-re-pat" placeholder="正则或普通词，如 /一口气.*看完/i"></div>
      <div class="addrow" style="margin-top:6px"><input type="text" id="bfb-re-txt" placeholder="样例文本（粘个标题来试）"></div>
      <div class="hint" id="bfb-re-out" style="margin-top:6px">输入正则与样例文本，实时显示是否命中。/.../ 按正则，否则按普通词（包含即命中）。</div>`;
    G.tools.appendChild(retest);
    const rePat = retest.querySelector('#bfb-re-pat');
    const reTxt = retest.querySelector('#bfb-re-txt');
    const reOut = retest.querySelector('#bfb-re-out');
    const runReTest = () => {
      const pat = (rePat.value || '').trim();
      const txt = reTxt.value || '';
      if (!pat) {
        reOut.textContent = '输入正则与样例文本，实时显示是否命中。';
        reOut.style.color = '';
        return;
      }
      let re;
      const m = pat.match(/^\/(.*)\/([a-z]*)$/);
      try {
        re = m ? new RegExp(m[1], m[2].includes('i') ? m[2] : m[2] + 'i') : new RegExp(escapeRe(pat), 'i');
      } catch (e) {
        reOut.textContent = '⚠ 正则语法错误：' + e.message;
        reOut.style.color = '#e74c3c';
        return;
      }
      if (!txt) {
        reOut.textContent = `已就绪（${m ? '正则' : '普通词'}），输入样例文本看是否命中。`;
        reOut.style.color = '';
        return;
      }
      const hit = re.test(txt);
      reOut.textContent = hit ? '✅ 命中' : '✗ 未命中';
      reOut.style.color = hit ? '#1b7a3d' : '#999';
    };
    rePat.oninput = runReTest;
    reTxt.oninput = runReTest;

    const io = document.createElement('div');
    io.className = 'sec';
    io.innerHTML = `<label>规则配置 导入 / 导出（备份 / 分享给其他人）</label>
      <div class="toolbar"><button class="act" id="bfb-export">⬇ 导出为文件</button><button class="act ghost" id="bfb-import">⬆ 从文件导入</button></div>
      <div class="hint">导出你的全部过滤规则与开关（不含统计/缓存/个人偏好）。导入时：规则列表取<b>并集</b>（不会丢现有规则），开关以导入值为准。</div>`;
    G.tools.appendChild(io);
    io.querySelector('#bfb-export').onclick = () => {
      const blob = new Blob([exportConfig()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `biliHoyoFairy-rules-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast('已导出规则配置文件');
    };
    io.querySelector('#bfb-import').onclick = () => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'application/json,.json';
      inp.onchange = () => {
        const f = inp.files && inp.files[0];
        if (!f) return;
        const r = new FileReader();
        r.onload = () => {
          try {
            const parsed = JSON.parse(r.result);
            const incoming = parsed && parsed.config ? parsed.config : parsed;
            if (!incoming || typeof incoming !== 'object') throw new Error('bad');
            // 先合并到副本并校验结构，避免坏配置原地写坏 CONFIG 并被持久化
            const draft = structuredClone(CONFIG);
            mergeImport(draft, incoming);
            const okObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
            if (!okObj(draft.block) || !okObj(draft.allow)) throw new Error('bad');
            Object.assign(CONFIG, draft);
            saveConfig();
            rescanAfterRuleChange();
            renderPanel(p);
            p.classList.add('open');
            toast('已导入并合并规则配置');
          } catch (e) {
            toast('导入失败：文件不是有效的配置 JSON');
          }
        };
        r.readAsText(f);
      };
      inp.click();
    };

    // —— 规则订阅 ——
    const subSec = document.createElement('div');
    subSec.className = 'sec';
    subSec.innerHTML = `<label>规则订阅（从 URL 自动拉取并合并黑名单）</label>
      <div class="addrow"><input type="text" id="bfb-sub-url" placeholder="订阅 URL（JSON 或文本，如 GitHub raw）"></div>
      <div class="addrow" style="margin-top:6px"><input type="text" id="bfb-sub-name" placeholder="备注名（可选）"><button id="bfb-sub-add">添加</button></div>
      <div class="hint">订阅只并入<b>黑名单</b>（UID/UP名/关键词/分区/标签/简介/BV），不影响你的白名单与开关；启用后按列表声明的周期自动刷新。</div>
      <div class="toolbar" style="margin-top:8px"><button class="act ghost" id="bfb-sub-refresh">🔄 全部刷新</button></div>
      <div id="bfb-sub-list" style="margin-top:8px"></div>`;
    G.tools.appendChild(subSec);
    const subListEl = subSec.querySelector('#bfb-sub-list');
    const fmtSubTime = (t) => (t ? new Date(t).toLocaleString() : '从未');
    const renderSubList = () => {
      subListEl.innerHTML = '';
      const store = loadSubStore();
      const subs = CONFIG.subscriptions || [];
      if (!subs.length) {
        const e = document.createElement('div');
        e.className = 'empty';
        e.textContent = '（暂无订阅，添加 URL 后会显示在这里）';
        subListEl.appendChild(e);
        return;
      }
      subs.forEach((sub, idx) => {
        const e = store[sub.url] || {};
        const status = e.ok ? `✅ ${e.count || 0} 条 · ${fmtSubTime(e.lastSync)}` : e.error ? `⚠ ${e.error}` : '未同步';
        const row = document.createElement('div');
        row.style.cssText = 'border:1px solid #eee;border-radius:8px;padding:8px;margin-top:6px;background:#fafafa';
        row.innerHTML = `
          <label class="switch" style="margin:0"><input type="checkbox" class="sub-en" ${sub.enabled ? 'checked' : ''}> <b>${escapeHtml(sub.name || metaGet(e.meta, 'title') || '订阅')}</b></label>
          <div style="font-size:11px;color:#aaa;word-break:break-all;margin-top:4px">${escapeHtml(sub.url)}</div>
          <div style="font-size:11px;color:#888;margin-top:4px">${escapeHtml(status)}</div>
          <div class="chip-bar"><button class="chip-act sub-refresh">刷新</button><button class="chip-act sub-del">删除</button></div>`;
        row.querySelector('.sub-en').onchange = (ev) => {
          sub.enabled = ev.target.checked;
          saveConfig();
          rescanAfterRuleChange();
        };
        row.querySelector('.sub-refresh').onclick = () => {
          toast('刷新中…');
          syncSubscription(sub.url, (ok) => {
            rescanAfterRuleChange();
            renderSubList();
            toast(ok ? '已刷新' : '刷新失败');
          });
        };
        row.querySelector('.sub-del').onclick = () => {
          if (!confirm('删除该订阅？其规则将立即移除')) return;
          CONFIG.subscriptions.splice(idx, 1);
          const st = loadSubStore();
          delete st[sub.url];
          saveSubStore(st);
          saveConfig();
          rescanAfterRuleChange();
          renderSubList();
        };
        subListEl.appendChild(row);
      });
    };
    renderSubList();
    subSec.querySelector('#bfb-sub-add').onclick = () => {
      const urlEl = subSec.querySelector('#bfb-sub-url');
      const nameEl = subSec.querySelector('#bfb-sub-name');
      const url = (urlEl.value || '').trim();
      const name = (nameEl.value || '').trim();
      if (!/^https?:\/\//i.test(url)) return toast('请输入有效的 http(s) URL');
      if ((CONFIG.subscriptions || []).some((s) => s.url === url)) return toast('该订阅已存在');
      CONFIG.subscriptions = CONFIG.subscriptions || [];
      CONFIG.subscriptions.push({ url, name, enabled: true });
      saveConfig();
      urlEl.value = '';
      nameEl.value = '';
      renderSubList();
      toast('已添加，正在拉取…');
      syncSubscription(url, (ok) => {
        rescanAfterRuleChange();
        renderSubList();
        toast(ok ? '订阅已同步' : '拉取失败，请检查 URL');
      });
    };
    subSec.querySelector('#bfb-sub-refresh').onclick = () => {
      toast('刷新全部订阅…');
      refreshSubscriptions(true, (n) => {
        renderSubList();
        toast(`已刷新（${n} 条有更新）`);
      });
    };

    const batch = document.createElement('div');
    batch.className = 'sec';
    batch.innerHTML = `<label>批量拉黑</label>
      <button class="act" id="bfb-batch-block" style="width:100%">⛔ 拉黑当前页所有已屏蔽的 UP</button>
      <div class="hint">扫描本页所有被屏蔽的卡片并拉黑其 UP；拿不到 UID 的会用 BV 号联网解析。此操作写入账号黑名单、不可一键撤销，会二次确认。</div>`;
    G.tools.appendChild(batch);
    batch.querySelector('#bfb-batch-block').onclick = () => {
      const blocked = document.querySelectorAll('[' + ATTR_BLOCKED + ']');
      if (!blocked.length) {
        toast('当前页还没有被屏蔽的卡片，先用规则屏蔽再批量拉黑');
        return;
      }
      const direct = []; // 卡片直接带 UID
      const toResolve = []; // 只有 BV，需联网反查
      let noInfo = 0;
      blocked.forEach((card) => {
        const i = extractCardInfo(card); // 实时重抠，避免首屏缓存空值
        const cu = !i.uid && i.bvid ? cachedUid(i.bvid) : '';
        if (i.uid) direct.push({ uid: String(i.uid), name: i.up || '' });
        else if (cu) direct.push({ uid: cu, name: i.up || '' });
        else if (i.bvid) toResolve.push({ bvid: i.bvid, name: i.up || '' });
        else noInfo++;
      });
      const est = direct.length + toResolve.length;
      if (!est) {
        toast(`本页 ${blocked.length} 张已屏蔽，但都拿不到 UID/BV，无法拉黑`);
        return;
      }
      const slowTip = toResolve.length ? `\n其中 ${toResolve.length} 位需联网解析 UID（稍慢）` : '';
      const skipTip = noInfo ? `\n（${noInfo} 张信息不足已跳过）` : '';
      if (!confirm(`将拉黑当前页约 ${est} 位 UP。${slowTip}${skipTip}\n\n会写入账号黑名单且不可一键撤销，确定？`)) return;

      const runBlacklist = (all) => {
        toast(`开始拉黑 ${all.length} 位…`);
        doBlacklistMany(all, (r) => {
          toast(`批量拉黑完成：新拉黑 ${r.added}，已在黑名单 ${r.already}${r.failed.length ? `，失败 ${r.failed.length}（多为未登录/风控/已满）` : ''}`);
          refreshPanelIfOpen();
        });
      };

      if (!toResolve.length) {
        runBlacklist(direct);
        return;
      }
      toast(`正在解析 ${toResolve.length} 个 UID…`);
      const resolved = [];
      let pending = toResolve.length;
      toResolve.forEach((t) => {
        fetchView(t.bvid, (d) => {
          if (d && d.owner) resolved.push({ uid: String(d.owner.mid), name: d.owner.name || t.name });
          if (CONFIG.blacklistCollab && d && Array.isArray(d.staff)) {
            d.staff.forEach((s) => resolved.push({ uid: String(s.mid), name: s.name || '' }));
          }
          if (--pending === 0) runBlacklist(direct.concat(resolved));
        });
      });
    };

    // —— 名单批量处理：粘贴/文件/URL 载入一批 UID 或名称 → 仅屏蔽（本地）或 拉黑（写账号黑名单）——
    const listSec = document.createElement('div');
    listSec.className = 'sec';
    listSec.innerHTML = `<label>名单批量处理（粘贴 / 文件 / URL）</label>
      <textarea id="bfb-list-input" rows="4" placeholder="粘贴一批 UID 或 UP 名，空格 / 逗号 / 换行 / 分号 分隔均可。&#10;纯数字按 UID；其它按 UP 名；也支持 uid:123 / up:名字 前缀。" style="width:100%;box-sizing:border-box;resize:vertical;font-family:monospace;font-size:12px;padding:6px;border:1px solid #ddd;border-radius:6px"></textarea>
      <div class="toolbar" style="margin-top:6px">
        <button class="act ghost" id="bfb-list-file">📁 从文件载入</button>
        <button class="act ghost" id="bfb-list-url">🔗 从 URL 载入</button>
      </div>
      <div class="toolbar" style="margin-top:6px">
        <button class="act" id="bfb-list-hide">仅屏蔽（本地）</button>
        <button class="act ghost" id="bfb-list-block" style="color:#e74c3c">⛔ 拉黑（写账号黑名单）</button>
      </div>
      <div class="hint">「仅屏蔽」只在本地隐藏、不碰账号；「拉黑」会写入账号黑名单（刷新后不再推荐），限速执行、触发风控自动暂停续传、<b>不可一键撤销</b>、执行前二次确认。只有名称没 UID 的，拉黑时自动降级为仅本地屏蔽。拉黑成功的会进下方「屏蔽记录」。</div>
      <div id="bfb-list-status" class="stat" style="margin-top:6px;min-height:1.2em"></div>`;
    // 归到「导入/导出」一族：插到「规则订阅」之前，紧跟导入区
    G.tools.insertBefore(listSec, subSec);
    const listTa = listSec.querySelector('#bfb-list-input');
    const listStatus = listSec.querySelector('#bfb-list-status');
    // 解析输入：拆分（空格/逗号/换行/分号/顿号）→ 纯数字或 uid:前缀=UID，up:前缀或其它=名称；跳过 ! # 注释行首
    const parseList = () => {
      const uids = [];
      const names = [];
      const seen = new Set();
      const addUid = (u) => {
        if (!seen.has(u)) {
          seen.add(u);
          uids.push(u);
        }
      };
      String(listTa.value || '')
        .split(/[\s,，;；、]+/)
        .forEach((tok) => {
          const t = (tok || '').trim();
          if (!t || t[0] === '!' || t[0] === '#') return;
          let m;
          if ((m = t.match(/^uid:\s*(\d+)$/i))) addUid(m[1]);
          else if ((m = t.match(/^up:\s*(.+)$/i))) {
            const nm = m[1].trim();
            if (nm) names.push(nm);
          } else if (/^\d{3,}$/.test(t)) addUid(t);
          else names.push(t);
        });
      return { uids, names };
    };
    // 仅屏蔽：UID→block.uids，名称→block.upNames（批量去重，最后统一存盘+重扫，避免逐条重扫）
    const addLocalMany = (uids, names) => {
      let n = 0;
      const push = (arr, v) => {
        if (!arr.map(String).includes(String(v))) {
          arr.push(String(v));
          n++;
        }
      };
      uids.forEach((u) => push(CONFIG.block.uids, u));
      names.forEach((nm) => push(CONFIG.block.upNames, nm));
      if (n) {
        saveConfig();
        rescanAfterRuleChange();
      }
      return n;
    };
    listSec.querySelector('#bfb-list-file').onclick = () => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.txt,.csv,.json,text/plain,application/json';
      inp.onchange = () => {
        const f = inp.files && inp.files[0];
        if (!f) return;
        const r = new FileReader();
        r.onload = () => {
          listTa.value = (listTa.value ? listTa.value + '\n' : '') + String(r.result || '');
          toast('已载入文件内容到输入框，确认后点 仅屏蔽 / 拉黑');
        };
        r.readAsText(f);
      };
      inp.click();
    };
    listSec.querySelector('#bfb-list-url').onclick = () => {
      const url = (prompt('输入名单 URL（纯文本：每行一个 UID 或 UP 名）：') || '').trim();
      if (!url) return;
      if (!/^https?:\/\//i.test(url)) return toast('请输入有效的 http(s) URL');
      if (typeof GM_xmlhttpRequest !== 'function') return toast('当前环境不支持联网载入');
      toast('载入中…');
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 15000,
        onload: (r) => {
          if (r.status >= 200 && r.status < 300 && r.responseText) {
            listTa.value = (listTa.value ? listTa.value + '\n' : '') + r.responseText;
            toast('已载入 URL 内容到输入框，确认后点 仅屏蔽 / 拉黑');
          } else toast('载入失败：HTTP ' + r.status);
        },
        onerror: () => toast('网络错误，载入失败'),
        ontimeout: () => toast('载入超时'),
      });
    };
    listSec.querySelector('#bfb-list-hide').onclick = () => {
      const { uids, names } = parseList();
      if (!uids.length && !names.length) return toast('没解析到有效的 UID / 名称');
      const n = addLocalMany(uids, names);
      toast(`已本地屏蔽：新增 ${n} 条（解析到 UID ${uids.length} / 名称 ${names.length}）`);
      renderPanel(p);
      p.classList.add('open');
    };
    listSec.querySelector('#bfb-list-block').onclick = () => {
      const { uids, names } = parseList();
      if (!uids.length && !names.length) return toast('没解析到有效的 UID / 名称');
      const est = Math.ceil(uids.length * 1.3); // 约 0.9~1.6s/个
      const nameTip = names.length ? `\n另有 ${names.length} 个只有名称（无 UID）→ 仅本地屏蔽，不写账号` : '';
      if (uids.length && !confirm(`将把 ${uids.length} 个 UID 写入你的账号黑名单（限速约 ${est} 秒起，触发风控会自动暂停续传、耗时更久），不可一键撤销。${nameTip}\n\n执行期间请保持此页面打开。确定继续？`)) return;
      const nLocal = addLocalMany([], names); // 名称部分仅本地屏蔽
      if (!uids.length) {
        toast(`无 UID 可账号拉黑；已本地屏蔽 ${nLocal} 个名称`);
        renderPanel(p);
        p.classList.add('open');
        return;
      }
      toast(`开始拉黑 ${uids.length} 个…执行期间请勿关闭面板`);
      listStatus.textContent = `准备拉黑 ${uids.length} 个…`;
      doBlacklistMany(
        uids.map((u) => ({ uid: u, name: '' })),
        (r) => {
          // 如实拆分：新拉黑(code0) / 此前已在黑名单(22120) / 失败(各 code)。失败回填输入框便于一键重试。
          const failUids = r.failed.map((f) => f.uid);
          const byCode = {};
          r.failed.forEach((f) => (byCode[f.code] = (byCode[f.code] || 0) + 1));
          const failBreak = Object.entries(byCode)
            .map(([c, n]) => `${REL_ERR[c] || 'code ' + c}×${n}`)
            .join('、');
          listStatus.innerHTML =
            `✅ 完成（共 ${r.total}）：<b>新拉黑 ${r.added}</b>` +
            (r.already ? ` · 此前已在黑名单 ${r.already}` : '') +
            (failUids.length ? ` · <b style="color:#e74c3c">失败 ${failUids.length}</b>（${escapeHtml(failBreak)}；已回填可重试）` : '') +
            (nLocal ? ` · 另本地屏蔽 ${nLocal} 名称` : '') +
            `<br><span style="color:#888">官方黑名单本次新增 = 新拉黑 ${r.added} 个（"已在黑名单"的不会再叠加；如仍对不上，多为风控/已满，开调试模式看控制台 code 明细）</span>`;
          listTa.value = failUids.length ? failUids.join('\n') : '';
          toast(`完成：新拉黑 ${r.added}，已在黑名单 ${r.already}，失败 ${failUids.length}`);
          if (panelStatsRefresh) panelStatsRefresh();
        },
        (pg) => {
          listStatus.textContent = pg.paused
            ? `⚠ 触发风控，已暂停约 ${pg.wait}s 后自动继续 · 进度 ${pg.done}/${pg.total}（新拉黑 ${pg.added}，已在 ${pg.already}，失败 ${pg.fail}）`
            : `拉黑中 ${pg.done}/${pg.total} · 新拉黑 ${pg.added}${pg.already ? `，已在 ${pg.already}` : ''}${pg.fail ? `，失败 ${pg.fail}` : ''}…`;
          if (panelStatsRefresh) panelStatsRefresh();
        }
      );
    };

    const tool = document.createElement('div');
    tool.className = 'sec toolbar';
    tool.innerHTML = `<button class="act ghost" id="bfb-clearcount">清空计数/记录</button><button class="act ghost" id="bfb-reset">恢复默认</button>`;
    G.tools.appendChild(tool);
    tool.querySelector('#bfb-clearcount').onclick = () => {
      CONFIG.blockedCount = 0;
      sessionBlocked = 0;
      blockedLog.length = 0;
      saveConfig();
      updateBadge();
      renderPanel(p);
      p.classList.add('open');
      toast('已清空计数与本次记录');
    };
    tool.querySelector('#bfb-reset').onclick = () => {
      if (confirm('确定恢复默认配置？现有规则将清空。')) {
        Object.assign(CONFIG, structuredClone(DEFAULT_CONFIG));
        saveConfig();
        rescanAfterRuleChange();
        renderPanel(p);
        p.classList.add('open');
      }
    };

    const logSec = document.createElement('div');
    logSec.className = 'sec';
    logSec.innerHTML =
      `<label>🔎 屏蔽记录（本次会话共 <span id="bfb-log-count">0</span> 条） <button class="act ghost" id="bfb-log-toggle" style="float:right">展开/收起</button></label>` +
      `<div class="stat" id="bfb-log-tally">分类：暂无</div>` +
      `<div id="bfb-log-list" style="display:none;max-height:240px;overflow:auto;overscroll-behavior:contain;margin-top:6px;font-size:12px"></div>`;
    G.tools.appendChild(logSec);
    const logList = logSec.querySelector('#bfb-log-list');
    const logCount = logSec.querySelector('#bfb-log-count');
    const logTally = logSec.querySelector('#bfb-log-tally');
    const foot = document.createElement('div');
    foot.className = 'sec';
    foot.innerHTML = `<a class="manage" href="${BLACKLIST_MANAGE_URL}" target="_blank">→ 打开 B 站官方黑名单管理页（取消拉黑/查看人数）</a>
      <div class="stat" style="margin-top:6px">累计拦截 <span id="bfb-foot-total">0</span> 次 · 本次会话 <span id="bfb-foot-session">0</span> 次</div>`;
    G.tools.appendChild(foot);
    const footTotal = foot.querySelector('#bfb-foot-total');
    const footSession = foot.querySelector('#bfb-foot-session');
    // 头部计数/分类/列表 三者用同一函数刷新，命中时实时更新，避免对不上
    const refreshLog = () => {
      logCount.textContent = blockedLog.length;
      const tally = tallyLog();
      logTally.textContent =
        '分类：' + (Object.keys(tally).length ? Object.entries(tally).map(([k, v]) => `${k}×${v}`).join('  ') : '暂无');
      footTotal.textContent = CONFIG.blockedCount;
      footSession.textContent = sessionBlocked;
      if (logList.style.display !== 'none') {
        logList.innerHTML = '';
        if (!blockedLog.length) {
          logList.innerHTML = '<div class="stat">暂无记录</div>';
          return;
        }
        blockedLog.slice(0, 100).forEach((b) => {
          const row = document.createElement('div');
          row.className = 'log-row';
          const tx = document.createElement('span');
          tx.className = 'log-tx';
          // 标题缺失（常见于广告卡）时退而显示 落地页 / BV / UID，至少能辨识拦了什么
          const desc =
            b.title ||
            (b.link ? b.link.replace(/^https?:\/\//, '').slice(0, 48) : '') ||
            b.bvid ||
            (b.uid ? 'UID ' + b.uid : '') ||
            '(无可辨识信息)';
          const srcTag =
            b.src === 'BL'
              ? '<span class="log-src net">黑</span>'
              : b.src === 'NET'
              ? '<span class="log-src net">拦</span>'
              : b.src === 'CMT'
              ? '<span class="log-src dom">评</span>'
              : '<span class="log-src dom">隐</span>';
          tx.innerHTML = `${srcTag}<span class="log-rs">[${escapeHtml(b.reason)}]</span> ${b.up ? '<b>' + escapeHtml(b.up) + '</b> · ' : ''}${escapeHtml(desc)}`;
          // hover 显示完整信息（标题常被截断，便于二次确认是否拉黑）：UP · 完整标题 · BV，附落地页
          tx.title =
            (b.up ? b.up + ' · ' : '') +
            (b.title || desc) +
            (b.bvid ? '  ·  ' + b.bvid : '') +
            (b.uid ? '  ·  UID ' + b.uid : '') +
            (b.link ? '\n' + b.link : '');
          row.appendChild(tx);
          // 放行（撤销/防误伤）：把该 UP 加白名单，永不再拦。DOM 隐藏的立刻恢复；网络拦截删掉的需刷新页面。
          if (b.up || b.uid) {
            const pass = document.createElement('button');
            pass.className = 'log-pass';
            pass.textContent = '✅放行';
            pass.title = '误伤了？把该 UP 加入白名单（永不屏蔽）。DOM 隐藏的会立即恢复，网络拦截删除的刷新后恢复。';
            pass.onclick = () => {
              if (b.uid) addToList(CONFIG.allow.uids, b.uid);
              else addToList(CONFIG.allow.upNames, b.up);
              toast(`已放行并加入白名单：${b.up || 'UID ' + b.uid}`);
              refreshPanelIfOpen();
            };
            row.appendChild(pass);
          }
          if (b.up || b.uid || b.bvid) {
            const blk = document.createElement('button');
            blk.className = 'log-blk';
            blk.textContent = '⛔拉黑';
            blk.title = '拉黑该 UP（同步账号黑名单）';
            blk.onclick = () => {
              blk.disabled = true;
              blk.textContent = '…';
              blacklistUp({ up: b.up, uid: b.uid, bvid: b.bvid }, () => refreshLog());
            };
            row.appendChild(blk);
          }
          logList.appendChild(row);
        });
      }
    };
    logSec.querySelector('#bfb-log-toggle').onclick = () => {
      logList.style.display = logList.style.display === 'none' ? 'block' : 'none';
      refreshLog();
    };
    panelStatsRefresh = refreshLog;
    refreshLog();
  }

  function panelEl() {
    return document.getElementById('bfb-panel');
  }
  function isPanelOpen() {
    const p = panelEl();
    return !!(p && p.classList.contains('open'));
  }
  function openPanel() {
    buildPanel();
    const p = panelEl();
    renderPanel(p);
    p.classList.add('open');
  }
  function closePanel() {
    const p = panelEl();
    if (p) p.classList.remove('open');
  }
  function refreshPanelIfOpen() {
    if (!isPanelOpen()) return;
    renderPanel(panelEl());
  }

  /* ===================== 9. 热搜屏蔽 ===================== */
  const HOTSEARCH_SELECTORS = [
    '.trending',
    '.search-panel .trending-list',
    '.search-panel-popover .trending',
    '.bili-header [class*="trending"]',
    '.center-search-container [class*="trending"]',
    '.search-panel [class*="trending"]',
    '.history-panel [class*="trending"]',
  ];
  function applyHotSearchStyle() {
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

  /* ===================== 10. 启动 ===================== */
  function start() {
    console.log(
      `%c[biliHoyoFairy]%c v${VERSION} 已启动 | 页面:${pageType()} | 拦截:${CONFIG.enabled ? '开' : '关'}${CONFIG.debug ? ' | 调试' : ''}`,
      BADGE + ';font-weight:bold',
      'color:#fb7299'
    );
    updateBadge();
    applyHotSearchStyle();
    harvestShadowRoots(document);
    scanAll();
    scanComments();
    // 订阅：用缓存先生效（buildMatchers 已并入），再按 expires 后台刷新（到期才拉，完成自动重扫）
    refreshSubscriptions(false);
    // 事件处理全部走错误边界，单次异常不致让监听器静默失效
    document.addEventListener('contextmenu', safe('onContextMenu', onContextMenu), true);
    document.addEventListener('mouseover', safe('onCardHover', onCardHover), true);
    document.addEventListener('scroll', safe('hideHoverBtn', hideHoverBtn), true);

    // 信息流无限滚动：节流扫描新卡（已处理过的卡会被廉价短路跳过）
    let sawShadowHost = false; // 本批是否出现新的 shadow host；没有就不做昂贵的全子树采集
    const observer = new MutationObserver(safe('observer', (muts) => {
      let touched = false;
      for (const m of muts) {
        if (m.addedNodes && m.addedNodes.length) {
          touched = true;
          for (const n of m.addedNodes) {
            if (n.nodeType === 1 && n.shadowRoot && n.id !== 'bfb-overlay-host') {
              shadowRoots.add(n.shadowRoot);
              sawShadowHost = true;
            }
          }
        }
      }
      if (touched) {
        if (start._t) return;
        start._t = setTimeout(() => {
          start._t = null;
          // shadow host 极少出现：仅在本批确实新增了 host 时，才做一次（节流内的）全子树采集，常态零成本
          if (sawShadowHost) {
            sawShadowHost = false;
            harvestShadowRoots(document);
          }
          scanAll();
        }, 250);
      }
    }));
    observer.observe(document.body, { childList: true, subtree: true });

    // 首屏稳定后弹一次「本次拦截」汇总：让你确认脚本真的在干活（区别于 B 站随机换批）
    setTimeout(() => {
      if (!CONFIG.enabled || sessionBlocked <= 0) return;
      const top = Object.entries(tallyLog())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([k, v]) => `${k}×${v}`)
        .join('、');
      toast(`🛡 本次加载已拦截 ${sessionBlocked} 个：${top}（点右下角🛡看明细 / 放行）`);
    }, 3500);

    GM_registerMenuCommand('打开设置面板', openPanel);
    GM_registerMenuCommand('暂停/启用拦截', () => {
      CONFIG.enabled = !CONFIG.enabled;
      saveConfig();
      updateBadge();
      if (CONFIG.enabled) scanAll();
    });
    GM_registerMenuCommand('打开官方黑名单管理页', () => window.open(BLACKLIST_MANAGE_URL, '_blank'));
  }

  // 拦截层必须尽早安装（document-start，先于页面脚本发起请求 / 构建评论组件）
  installNetworkHooks();
  installShadowHook();

  // DOM 兜底层依赖 DOM，延迟到文档就绪再启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
