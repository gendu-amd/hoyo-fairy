// ==UserScript==
// @name         hoyoFairy · 抗击黑潮
// @namespace    https://github.com/gendu-amd/hoyo-fairy
// @version      0.0.1
// @description  清理 B 站推荐流里的黑流量、引战视频、商业广告，并屏蔽你不想看的 UP 主。支持按 标签/UP主/UID/关键词(可正则)/时长/播放量/BV 精准过滤；覆盖首页/热门/排行榜/搜索/播放页；白名单优先防误伤；右键一键屏蔽/拉黑(同步账号黑名单)；内置预置关键词库。
// @author       gendu
// @match        https://www.bilibili.com/*
// @match        https://search.bilibili.com/*
// @updateURL    https://raw.githubusercontent.com/gendu-amd/hoyo-fairy/main/hoyo-fairy.user.js
// @downloadURL  https://raw.githubusercontent.com/gendu-amd/hoyo-fairy/main/hoyo-fairy.user.js
// @connect      api.bilibili.com
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
  const VERSION = '0.0.1';
  const STORE_KEY = 'bfb_config_v2';
  const BLACKLIST_MANAGE_URL = 'https://account.bilibili.com/account/blacklist';
  const BADGE = 'color:#fff;background:#fb7299;padding:0 4px;border-radius:3px'; // 控制台日志的品牌徽标样式

  const DEFAULT_CONFIG = {
    enabled: true,
    reviewMode: false, // 审查模式：被拦视频不删/不隐，而是标记+就地放行，便于核对防误伤
    rightClickBlock: true,
    blacklistCollab: false, // 拉黑联合投稿时，是否把所有合作者一并拉黑
    block: {
      keywords: [], // 命中 标题/UP名/分区（标签需开精确过滤）；普通词=包含，/.../ =正则
      upNames: [],
      uids: [],
      bvids: [],
      minDuration: 0,
      maxDuration: 0,
      minViews: 0, // 万；>0 时播放量低于此值的视频被拦
      // —— 以下为需要读取接口数据的维度（仅在开启「精确过滤」后生效）——
      tags: [], // 视频标签黑名单（标题区看不到，需调接口；支持 /正则/）
      dualTags: [], // 双重标签，"原神+鸣潮" 形式，同时命中两组才拦（治引战）
      upBio: [], // UP 简介关键词黑名单（支持 /正则/）
    },
    allow: { keywords: [], upNames: [], uids: [] },
    hideAd: false,
    hideHotSearch: false,
    apiFilters: false, // 精确过滤总开关（关闭时完全不联网）
    hideCharging: false, // 充电专属视频（API）
    debug: false,
    blockedCount: 0,
    uidNames: {}, // uid -> UP 名 缓存（仅用于面板按名称展示；拉黑仍用 uid）
  };

  const PRESET_LIBRARY = {
    营销号UP名: ['今日话题', '话题酱', '今日知乎', '大型纪录片'],
    标题党: ['/(一口气|一次性|一天|分钟|分半|小时)(看完|带你看完|直接看完)/', '/震惊|竟然|万万没想到/'],
    软传销: ['/(日入|日赚|月入|月赚)\\d+/', '/(小时|内耗).+为自己打工/'],
    MBTI: ['/MBTI|[IE][SN][TF][JP]|I人|E人/'],
    梗视频: ['科目三', '猫meme', '/是什么梗|梗百科|大型[纪记]录片/'],
    含日语标题: ['/[ぁ-ヶ]/'],
    寄生社蛆: ['库洛', '库洛游戏', '呜哇', '鸣潮', '战双', '战双帕弥什', '漂泊者', '漂泊神游', '寄生神游', '寄生社区'],
  };

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
  const NON_PORTABLE = ['blockedCount', 'uidNames', 'enabled', 'debug', 'reviewMode'];
  function exportConfig() {
    const c = structuredClone(CONFIG);
    NON_PORTABLE.forEach((k) => delete c[k]);
    return JSON.stringify({ app: 'hoyoFairy', version: VERSION, config: c }, null, 2);
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
  const bvUidCache = new Map(); // 会话内 bvid->uid 缓存（拉黑反查用；不持久化，推荐流 bvid 跨会话几乎不复用）

  /* ===================== 1. 工具 ===================== */
  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(^|;\\s*)' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[2]) : '';
  }
  const lc = (s) => (s || '').toString().trim().toLowerCase();

  function compileLines(lines) {
    const plains = [];
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
        plains.push(lc(line));
      }
    }
    return { plains, regexes };
  }
  function textHit(text, matcher) {
    if (!text) return false;
    const low = lc(text);
    for (const p of matcher.plains) if (p && low.includes(p)) return true;
    for (const r of matcher.regexes) if (r.test(text)) return true;
    return false;
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

  function pageType() {
    const h = location.href;
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
  ].join(',');

  // 定位要隐藏的网格格子：显式有序链，避免破坏布局。
  function cellOf(el) {
    const fc = el.closest('div.feed-card, div.bili-feed-card');
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

  function extractCardInfo(card) {
    const info = { title: '', up: '', uid: '', partition: '', bvid: '', duration: null, views: null, isLive: false, isAd: false };

    info.title = pickText(card, ['.bili-video-card__info--tit', '.video-name', 'h3[title]', '.title']);
    info.up = pickText(card, [
      '.bili-video-card__info--author',
      '.up-name__text',
      '.up-name',
      '.bili-video-card__info--owner span',
      '.upname .name',
    ]);

    // UID（拉黑必需）：space 链接 → data-* → innerHTML 兜底（含纯文本卡内嵌的 "mid":数字）
    const upA = card.querySelector('a[href*="space.bilibili.com"]');
    if (upA) info.uid = ((upA.getAttribute('href') || '').match(/space\.bilibili\.com\/(\d+)/) || [])[1] || '';
    if (!info.uid) {
      const midEl = card.querySelector('[data-mid],[data-up-mid],[data-user-id]');
      if (midEl) info.uid = midEl.getAttribute('data-mid') || midEl.getAttribute('data-up-mid') || midEl.getAttribute('data-user-id') || '';
    }
    if (!info.uid) info.uid = (card.innerHTML.match(/space\.bilibili\.com\/(\d+)/) || [])[1] || '';
    if (!info.uid) info.uid = (card.innerHTML.match(/"(?:mid|owner_?id|up_?mid)"\s*:\s*"?(\d{2,})"?/) || [])[1] || '';

    info.partition = pickText(card, ['.bili-video-card__info--tag', '.rcmd-tag']);

    const aVideo = card.querySelector('a[href*="/video/"]');
    if (aVideo) {
      const m = (aVideo.getAttribute('href') || '').match(/(BV[0-9A-Za-z]+)/);
      if (m) info.bvid = m[1];
    }

    info.duration = parseDuration(pickText(card, ['.bili-video-card__stats__duration', '.duration']));

    const statEl = card.querySelector('.bili-video-card__stats--item') || card.querySelector('.play-text');
    if (statEl) info.views = parseCount(statEl.textContent);

    // 直播：仅用于"别把直播误当广告"，不作为独立屏蔽项
    info.isLive = !!(
      card.querySelector('a[href*="live.bilibili.com"]') ||
      card.querySelector('.bili-live-card, [class*="live-card"]') ||
      /直播中|正在直播/.test(card.textContent || '')
    );

    const adBadge = Array.from(card.querySelectorAll('span,div')).some((el) => {
      const tx = (el.textContent || '').trim();
      return tx === '广告' || tx === '赞助' || tx === '推广';
    });
    const isRcmdAd =
      card.classList && card.classList.value.trim() === 'bili-video-card is-rcmd' &&
      !document.querySelector('div.recommend-container__2-line');
    info.isAd = !info.isLive && !!(
      card.querySelector('.bili-video-card__info--ad') ||
      card.querySelector('a[href*="cm.bilibili.com"]') ||
      card.querySelector('a[href*="//mall.bilibili.com"]') ||
      isRcmdAd ||
      adBadge
    );

    return info;
  }

  /* ===================== 4. 规则匹配（白名单优先） ===================== */
  let M = buildMatchers();
  function buildMatchers() {
    return {
      blockKw: compileLines(CONFIG.block.keywords),
      allowKw: compileLines(CONFIG.allow.keywords),
      blockTag: compileLines(CONFIG.block.tags),
      upBio: compileLines(CONFIG.block.upBio),
    };
  }
  function rebuildRules() {
    M = buildMatchers();
  }

  function isWhitelisted(info) {
    if (textHit(info.title, M.allowKw)) return true;
    if (info.up && textHit(info.up, M.allowKw)) return true;
    if (info.up && CONFIG.allow.upNames.some((n) => lc(n) === lc(info.up))) return true;
    if (info.uid && CONFIG.allow.uids.map(String).includes(info.uid)) return true;
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
    {
      match: (i) => {
        const b = CONFIG.block;
        return b.minViews > 0 && i.views != null && i.views < b.minViews * 1e4 ? `播放<${b.minViews}万` : null;
      },
    },
    // 关键词：标题 / UP名 / 分区任一命中即拦（标签维度在 matchApi 里补判）
    { match: (i) => (textHit(i.title, M.blockKw) || (i.up && textHit(i.up, M.blockKw)) || textHit(i.partition, M.blockKw) ? '关键词' : null) },
    { match: (i) => (i.up && CONFIG.block.upNames.some((n) => lc(n) === lc(i.up)) ? 'UP主:' + i.up : null) },
    { match: (i) => (i.uid && CONFIG.block.uids.map(String).includes(i.uid) ? 'UID:' + i.uid : null) },
    { match: (i) => (i.bvid && CONFIG.block.bvids.includes(i.bvid) ? 'BV:' + i.bvid : null) },
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
      active: () => CONFIG.block.tags.length || CONFIG.block.keywords.length,
      match: (info, ctx) => {
        for (const t of ctx.tags) {
          if (textHit(t, M.blockTag)) return '标签:' + t;
          if (textHit(t, M.blockKw)) return '关键词:' + t;
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
      active: () => CONFIG.block.upBio.length,
      match: (info, ctx) => ((M.upBio.plains.length || M.upBio.regexes.length) && textHit(ctx.sign, M.upBio) ? 'UP简介' : null),
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

  /* ===================== 4b. 接口层（缓存 + 限速队列，避免频繁请求） ===================== */
  // 小并发 + 较短冷却：兼顾速度与风控。每个请求完成后冷却 DELAY 再释放并发位。
  const API = { view: new Map(), tag: new Map(), card: new Map(), queue: [], active: 0, CONCURRENCY: 3, DELAY: 120 };
  function apiPump() {
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
          cb(JSON.parse(r.responseText));
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
        API.view.set(bvid, d);
        if (d && d.owner && d.owner.mid) {
          bvUidCache.set(bvid, String(d.owner.mid)); // 会话内反查用
          if (d.owner.name) {
            CONFIG.uidNames[String(d.owner.mid)] = d.owner.name; // 持久化：面板按名展示
            scheduleSave();
          }
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
    return {
      title: it.title || adC.title || adC.description || ad?.title || '',
      up: owner.name || it.author || it.name || (ad && ad.source_content && ad.source_content.name) || '',
      uid: owner.mid != null ? String(owner.mid) : it.mid != null ? String(it.mid) : '',
      partition: it.tname || (it.rcmd_reason && it.rcmd_reason.content) || '',
      bvid: it.bvid || '',
      link: it.uri || it.jump_url || adC.url || adC.jump_url || '',
      duration: typeof it.duration === 'number' ? it.duration : it.duration ? parseDuration(it.duration) : null,
      views: stat.view != null ? stat.view : stat.play != null ? stat.play : it.play != null ? it.play : null,
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
  ];
  const isFeedUrl = (url) => !!url && FEED_HOOKS.some((h) => h.re.test(url));

  // 就地过滤一个已解析的 JSON 响应，返回同一对象（数组被原地 splice）
  function filterFeedJson(url, json) {
    // 审查模式下不在数据层删项，让视频照常渲染，交给 DOM 层标记，便于核对
    if (!CONFIG.enabled || CONFIG.reviewMode || !json || json.code !== 0 || !json.data) return json;
    const hook = FEED_HOOKS.find((h) => h.re.test(url));
    if (!hook) return json;
    const arr = hook.get(json.data);
    if (!arr || !arr.length) return json;
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
    if (removed && CONFIG.debug) {
      console.log(`%c[hoyoFairy]%c 拦截层 删除 ${removed} 项 @ ${url.split('?')[0]}`, BADGE, 'color:#e67e22');
    }
    return json;
  }
  function computeFilteredText(url, raw) {
    try {
      return JSON.stringify(filterFeedJson(url, JSON.parse(raw)));
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
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const p = origFetch.apply(this, arguments);
        if (!isFeedUrl(url)) return p;
        return p.then((resp) =>
          resp
            .clone()
            .json()
            .then((json) => {
              // 重建响应：剔除 content-encoding/length（正文已是明文 JSON，旧头会误导消费者）
              const h = new Headers(resp.headers);
              h.delete('content-encoding');
              h.delete('content-length');
              return new RespCtor(JSON.stringify(filterFeedJson(url, json)), { status: resp.status, statusText: resp.statusText, headers: h });
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
        if (isFeedUrl(url)) {
          if (dText && dText.get) {
            Object.defineProperty(self, 'responseText', {
              configurable: true,
              get() {
                if (self.readyState !== 4) return dText.get.call(self);
                if (self.__bfbText === undefined) self.__bfbText = computeFilteredText(url, dText.get.call(self));
                return self.__bfbText;
              },
            });
          }
          if (dResp && dResp.get) {
            Object.defineProperty(self, 'response', {
              configurable: true,
              get() {
                if (self.readyState !== 4) return dResp.get.call(self);
                if (self.__bfbResp === undefined) {
                  const rt = self.responseType;
                  const orig = dResp.get.call(self);
                  try {
                    if (rt === 'json' && orig && typeof orig === 'object') self.__bfbResp = filterFeedJson(url, orig);
                    else if ((rt === '' || rt === 'text') && typeof orig === 'string') self.__bfbResp = computeFilteredText(url, orig);
                    else self.__bfbResp = orig;
                  } catch (e) {
                    self.__bfbResp = orig;
                  }
                }
                return self.__bfbResp;
              },
            });
          }
        }
        return origOpen.apply(this, arguments);
      };
      XHR.prototype.__bfb = true;
    }
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
    card.removeAttribute('data-bfb-blocked');
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
    if (CONFIG.debug) {
      console.log(
        `%c[hoyoFairy]%c 拦截🚫 ${reason}%c ${info && info.up ? info.up + ' · ' : ''}${(info && info.title) || '(无标题)'}`,
        BADGE,
        'color:#e74c3c',
        'color:inherit'
      );
    }
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
    card.setAttribute('data-bfb-blocked', '1'); // 供「批量拉黑」扫描
    if (countedEls.has(card)) return;
    countedEls.add(card);
    recordBlock(reason, info, 'DOM');
  }

  function processCard(card) {
    if (!CONFIG.enabled) return;
    if (card.getAttribute(PROCESSED)) return;
    const info = extractCardInfo(card);
    if (!info.title && !info.up) return; // 骨架卡，等填充后再处理
    card.setAttribute(PROCESSED, '1');
    card._bfbInfo = info;
    const hit = matchRule(info);
    if (CONFIG.debug && !hit) {
      console.log(
        `%c[hoyoFairy]%c 放行✅ | 标题:${info.title || '(无)'} | UP:${info.up || '(无)'} | 标签:${info.partition || '(无)'}`,
        BADGE,
        'color:#27ae60'
      );
    }
    if (hit) {
      blockVideo(card, hit, info);
      return;
    }
    // 过了本地规则、未命中白名单、且开了精确过滤 → 按需取数再判（限速、缓存）
    if (info.bvid && apiRulesActive()) evaluateApi(card, info);
  }

  // 异步评估：只取需要的接口，命中则隐藏/标记（与本地规则同一套出口 blockVideo）
  function evaluateApi(card, info) {
    if (card.getAttribute('data-bfb-api')) return;
    card.setAttribute('data-bfb-api', '1');
    const need = apiNeeds();
    let view = null;
    let tags = null;
    let cardData = null;
    let pending = 0;
    const finish = () => {
      if (pending > 0) return;
      if (!CONFIG.enabled || isWhitelisted(info)) return;
      const hit = matchApi(info, view, tags, cardData);
      if (hit) {
        blockVideo(card, hit, info);
      } else if (CONFIG.debug) {
        console.log(`%c[hoyoFairy]%c API放行 | ${info.title || ''}`, BADGE, 'color:#27ae60');
      }
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

  function scanAll() {
    if (!CONFIG.enabled) return;
    document.querySelectorAll(VIDEO_CARD_SELECTOR).forEach((card) => {
      if (card.getAttribute(PROCESSED)) return;
      if (card.closest('.recommended-swipe')) return; // 顶部轮播 banner，跳过
      processCard(card);
    });
  }

  function rescanAfterRuleChange() {
    rebuildRules();
    document.querySelectorAll('[' + PROCESSED + ']').forEach((el) => {
      el.removeAttribute(PROCESSED);
      el.removeAttribute('data-bfb-api');
      clearVisual(el);
    });
    scanAll();
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
    const cached = bvid && bvUidCache.get(bvid);
    if (cached) {
      cb(String(cached), CONFIG.uidNames[String(cached)] || '');
      return;
    }
    fetchView(bvid, (d) => {
      if (d && d.owner) cb(String(d.owner.mid), d.owner.name || '');
      else cb('', '');
    });
  }

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
      cb && cb(false);
      return;
    }
    GM_xmlhttpRequest({
      method: 'POST',
      url: 'https://api.bilibili.com/x/relation/modify',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: `fid=${encodeURIComponent(uid)}&act=5&re_src=11&csrf=${encodeURIComponent(csrf)}`,
      withCredentials: true,
      onload: (res) => {
        let ok = false;
        try {
          ok = JSON.parse(res.responseText).code === 0;
        } catch (e) {}
        addLocal();
        if (!quiet) toast(ok ? `已拉黑并同步账号黑名单：${label}（刷新后不再推荐）` : `账号侧拉黑失败，已本地屏蔽：${label}`);
        cb && cb(ok);
      },
      onerror: () => {
        addLocal();
        if (!quiet) toast(`网络错误，已本地屏蔽：${label}`);
        cb && cb(false);
      },
    });
  }

  // 顺序拉黑多个 UP（限速，避免触发风控）。targets: [{uid, name}]；cb(成功数, 总数)。
  function doBlacklistMany(targets, cb) {
    const list = [];
    const seen = new Set();
    for (const t of targets) {
      const uid = String((t && t.uid) || '');
      if (uid && !seen.has(uid)) {
        seen.add(uid);
        list.push({ uid, name: (t && t.name) || '' });
      }
    }
    let ok = 0;
    let i = 0;
    const next = () => {
      if (i >= list.length) {
        cb && cb(ok, list.length);
        return;
      }
      const t = list[i++];
      doBlacklist(t.uid, t.name, (s) => {
        if (s) ok++;
        setTimeout(next, 320);
      }, true);
    };
    if (!list.length) cb && cb(0, 0);
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
    const card = e.target.closest(VIDEO_CARD_SELECTOR);
    if (!card) return;
    const info = card._bfbInfo || extractCardInfo(card);
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
  document.addEventListener('click', closeCtxMenu, true);
  document.addEventListener('scroll', closeCtxMenu, true);

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
    #bfb-panel .sec.allow .chip.group{background:#eafaef}
    /* —— 分组 Tab —— */
    #bfb-panel .tabs{position:sticky;top:48px;z-index:2;display:flex;flex-wrap:wrap;gap:6px;padding:10px 12px;background:#fff;border-bottom:1px solid #f0f0f0;overscroll-behavior:contain}
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
        const parts = raw.split(/[,，;；\n]/).map((s) => s.trim()).filter(Boolean);
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
        const parts = raw.split(/[,，;；\n]/).map((s) => s.trim()).filter(Boolean);
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
    ['allow', '⭐ 白名单', '命中白名单的内容永不隐藏，优先级最高'],
    ['tools', '🧰 工具', '预置库 / 重置 / 屏蔽记录'],
  ];

  // 列表型字段描述表：黑名单 / 进阶标签 / 白名单。新增一类过滤只需在此加一行。
  const BLACK_FIELDS = [
    { key: 'keywords', label: '🎯 关键词', placeholder: '如：原神 或 /震惊.*竟然/', hint: '一次命中 标题 / UP主名 / 分区（开「精确过滤」后还会匹配视频标签）。普通词=包含即拦；/.../ 包裹=正则，如 /一口气.*看完/。' },
    { kind: 'up', label: 'UP 主', hint: '输入 UP 名 或 UID（纯数字自动识别为 UID）；可一次粘贴多条，用逗号或换行分隔。' },
    { key: 'bvids', label: 'BV 号', placeholder: '如：BV1xx411c7XX', hint: '按视频 BV 号精确屏蔽单个视频。' },
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
    h2.innerHTML = `🛡 hoyoFairy · 抗击黑潮 <small style="font-weight:normal;opacity:.6;font-size:12px">v${VERSION} · ${pageType()}</small> <span class="x">✕</span>`;
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
      <div class="switch"><input type="checkbox" id="bfb-collab"> 联合投稿一并拉黑合作者</div>
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
    bindControl(sw, 'bfb-collab', CONFIG, 'blacklistCollab');
    bindControl(sw, 'bfb-debug', CONFIG, 'debug', { after: rescanAfterRuleChange });

    const ct = document.createElement('div');
    ct.className = 'sec';
    ct.innerHTML = `
      <label>卡片类型过滤</label>
      <div class="switch"><input type="checkbox" id="bfb-ad"> 屏蔽广告/推广卡片</div>
      <div class="switch"><input type="checkbox" id="bfb-hotsearch"> 屏蔽搜索框热搜词</div>
      <div class="hint">广告为自动识别，偶有误差；可在下方「屏蔽记录」核对实际拦了什么。</div>`;
    G.base.appendChild(ct);
    bindControl(ct, 'bfb-ad', CONFIG, 'hideAd', { after: rescanAfterRuleChange });
    bindControl(ct, 'bfb-hotsearch', CONFIG, 'hideHotSearch', { after: applyHotSearchStyle });

    renderFields(G.black, BLACK_FIELDS);

    // 进阶页：播放量 / 时长（本地数值阈值，即时生效）
    const num = document.createElement('div');
    num.className = 'sec';
    num.innerHTML = `<label>播放量 / 时长</label>
      <div class="switch" style="margin-top:4px;font-weight:400">播放量低于 <input type="number" id="bfb-minviews" min="0" step="0.1" style="width:64px"> 万则屏蔽（0=不启用）</div>
      <div class="switch" style="margin-top:8px;font-weight:400">时长　最短 <input type="number" id="bfb-dmin" min="0" style="width:64px"> 秒　最长 <input type="number" id="bfb-dmax" min="0" style="width:64px"> 秒</div>
      <div class="hint">填 0 表示该项不启用。</div>`;
    G.api.appendChild(num);
    bindControl(num, 'bfb-minviews', CONFIG.block, 'minViews', { number: true, after: rescanAfterRuleChange });
    bindControl(num, 'bfb-dmin', CONFIG.block, 'minDuration', { number: true, int: true, after: rescanAfterRuleChange });
    bindControl(num, 'bfb-dmax', CONFIG.block, 'maxDuration', { number: true, int: true, after: rescanAfterRuleChange });

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

    renderFields(G.allow, ALLOW_FIELDS);

    const preset = document.createElement('div');
    preset.className = 'sec';
    preset.innerHTML = '<label>预置关键词库（点一下即加入关键词黑名单）</label><div class="toolbar" id="bfb-presets"></div>';
    G.tools.appendChild(preset);
    const presetBox = preset.querySelector('#bfb-presets');
    Object.keys(PRESET_LIBRARY).forEach((name) => {
      const btn = document.createElement('button');
      btn.className = 'act ghost';
      btn.textContent = '+ ' + name;
      btn.onclick = () => {
        let n = 0;
        for (const kw of PRESET_LIBRARY[name]) if (addToList(CONFIG.block.keywords, kw)) n++;
        toast(`已加入「${name}」${n} 条规则`);
        renderPanel(p);
        p.classList.add('open');
      };
      presetBox.appendChild(btn);
    });

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
      a.download = `hoyo-fairy-rules-${new Date().toISOString().slice(0, 10)}.json`;
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

    const batch = document.createElement('div');
    batch.className = 'sec';
    batch.innerHTML = `<label>批量拉黑</label>
      <button class="act" id="bfb-batch-block" style="width:100%">⛔ 拉黑当前页所有已屏蔽的 UP</button>
      <div class="hint">扫描本页所有被屏蔽的卡片并拉黑其 UP；拿不到 UID 的会用 BV 号联网解析。此操作写入账号黑名单、不可一键撤销，会二次确认。</div>`;
    G.tools.appendChild(batch);
    batch.querySelector('#bfb-batch-block').onclick = () => {
      const blocked = document.querySelectorAll('[data-bfb-blocked]');
      if (!blocked.length) {
        toast('当前页还没有被屏蔽的卡片，先用规则屏蔽再批量拉黑');
        return;
      }
      const direct = []; // 卡片直接带 UID
      const toResolve = []; // 只有 BV，需联网反查
      let noInfo = 0;
      blocked.forEach((card) => {
        const i = extractCardInfo(card); // 实时重抠，避免首屏缓存空值
        if (i.uid) direct.push({ uid: String(i.uid), name: i.up || '' });
        else if (i.bvid && bvUidCache.get(i.bvid)) direct.push({ uid: String(bvUidCache.get(i.bvid)), name: i.up || '' });
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
        doBlacklistMany(all, (n, total) => {
          toast(`批量拉黑完成：${n}/${total} 位成功${n < total ? '（失败多为未登录/风控，可稍后重试）' : ''}`);
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
          const srcTag = b.src === 'NET' ? '<span class="log-src net">拦</span>' : '<span class="log-src dom">隐</span>';
          tx.innerHTML = `${srcTag}<span class="log-rs">[${escapeHtml(b.reason)}]</span> ${b.up ? '<b>' + escapeHtml(b.up) + '</b> · ' : ''}${escapeHtml(desc)}`;
          if (b.link) tx.title = b.link;
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
      `%c[hoyoFairy]%c v${VERSION} 已启动 | 页面:${pageType()} | 拦截:${CONFIG.enabled ? '开' : '关'}${CONFIG.debug ? ' | 调试' : ''}`,
      BADGE + ';font-weight:bold',
      'color:#fb7299'
    );
    updateBadge();
    applyHotSearchStyle();
    scanAll();
    document.addEventListener('contextmenu', onContextMenu, true);

    // 信息流无限滚动：节流扫描新卡（已处理过的卡会被廉价短路跳过）
    const observer = new MutationObserver((muts) => {
      let touched = false;
      for (const m of muts) if (m.addedNodes && m.addedNodes.length) touched = true;
      if (touched) {
        if (start._t) return;
        start._t = setTimeout(() => {
          start._t = null;
          scanAll();
        }, 250);
      }
    });
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

  // 拦截层必须尽早安装（document-start，先于页面脚本发起请求）
  installNetworkHooks();

  // DOM 兜底层依赖 DOM，延迟到文档就绪再启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
