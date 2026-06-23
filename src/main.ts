// @ts-nocheck
/* eslint-disable */
// 整体 lift 自 v0.0.5 单文件快照（docs/review/v0.0.5-snapshot.user.js）。
// 注：本文件为「逐字搬运」的过渡基线，刻意不改 v0.0.5 逻辑，故关闭 ts/eslint 检查；
// 抽出的每个模块都是手写 TS、会受完整类型与 lint 约束。
// 作用：干净重模块化的「基线」——行为与 v0.0.5 等价；后续按体检 DAG 自底向上逐层抽出模块，
// 每抽一层都对照快照核对、强类型、补测。请勿手改本文件的逻辑，改动应通过抽模块进行。
// —— 已抽出的模块（自底向上逐层进行中）——
import { VERSION, STORE_KEY, SUB_STORE_KEY, BLACKLIST_MANAGE_URL, ATTR_API, ATTR_BLOCKED, PROCESSED, COMMENT_BOTS, COMMENT_AD_RE, UNSAFE_KEYS, RISK_CODES } from './constants';
import { getCookie, parseDuration, parseCount, escapeHtml } from './util';
import { lc, toHalfWidth, escapeRe, INVISIBLE_RE, stripInvisible, SEP_RE, configureFuzzy, normMatch, compileLines, textHit, KW_SCOPES, compileScopedKeywords, kwHit, splitRuleInput } from './match/normalize';
import { CONFIG, DEFAULT_CONFIG, saveConfig, scheduleSave, exportConfig, mergeImport } from './config';
import { log, logErr, safe } from './logging';
import { PRESET_LIBRARY } from './presets';
import { parseSubscription, SUB_DIMS } from './subscriptions/parse';
import { loadSubStore, saveSubStore } from './subscriptions/store';
import { extractCardInfo, normFeedItem, configureCardDetect } from './cardinfo';
import { M, ruleVersion, rebuildRules, isWhitelisted, matchRule, matchApi, apiNeeds, apiRulesActive, buildApiCtx, buildMatchers, SYNC_DIMS, API_DIMS } from './match/engine';
import { IS_SEARCH, IS_DYNAMIC, pageType, VIDEO_CARD_SELECTOR, cellOf, isUnsafeHideTarget } from './page';
import { riskGuard, fetchView, fetchTags, fetchCard, cachedUid } from './api';
import { installNetworkHooks } from './net';
import { shadowRoots, harvestShadowRoots } from './dom/shadow';
import { blockedLog, sessionBlocked, setSessionBlocked, tallyLog, logBlocked, recordBlock, setStatsListener } from './stats';
import { updateBadge, toast } from './ui/toast';
import { setPanelHooks } from './ui/hooks';
import { addToList, removeFromList } from './rules';
import { refreshSubscriptions, syncSubscription, metaGet } from './subscriptions/refresh';
import { setRulesChangedHandler } from './events';
import { CMT_TAGS, scanComments, scheduleCommentScan } from './comments';
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
  // VERSION/STORE_KEY/SUB_STORE_KEY/BLACKLIST_MANAGE_URL/ATTR_*/PROCESSED 等常量已抽到 ./constants
  // BADGE / log / logErr / safe 已抽到 ./logging（见顶部 import）

  // DEFAULT_CONFIG 已抽到 ./config；PRESET_LIBRARY 已抽到 ./presets（见顶部 import）

  // COMMENT_BOTS / COMMENT_AD_RE / UNSAFE_KEYS 已抽到 ./constants

  // deepMerge / loadConfig / saveConfig / scheduleSave / exportConfig / mergeImport / CONFIG 已抽到 ./config（模块加载即就绪）。
  // 匹配引擎 ./match/engine 在自身模块加载时已绑定 fuzzy 取值器并构建首个 M；
  // 此处仅把卡片广告/直播检测开关注入 ./cardinfo（保持 cardinfo 不直接依赖 CONFIG）。
  configureCardDetect(() => ({ detectAd: CONFIG.hideAd, detectLive: CONFIG.hideLiveCard }));
  // 注入 UI 回调桥：低层模块（stats 等）经此回调到面板/角标，避免 import 面板成环。
  setPanelHooks({
    refreshPanelIfOpen: () => refreshPanelIfOpen(),
    openPanel: () => openPanel(),
    isPanelOpen: () => isPanelOpen(),
  });
  // stats 命中记账后回调：更新角标 + 面板打开时刷新计数（document.body 未就绪时跳过角标）。
  setStatsListener(() => {
    if (document.body) updateBadge();
    if (panelStatsRefresh && isPanelOpen()) panelStatsRefresh();
  });
  // 规则变更 seam：rules / subscriptions 发事件，这里落到 DOM 层的重建+重扫（打断 dom↔rules 环）。
  setRulesChangedHandler(() => rescanAfterRuleChange());

  /* ===================== 0c. 规则订阅（数据层） ===================== */
  // SUB_DIMS / 文本前缀解析 / sanitizeSubRules / parseSubscription 已抽到 ./subscriptions/parse；
  // loadSubStore / saveSubStore / collectSubRules 已抽到 ./subscriptions/store（见顶部 import）。
  // 以下保留 订阅“刷新/同步”逻辑（联网，属 L4，后续再抽）。

  // metaGet / cmpVer / parseExpires / fetchSubText / syncSubscription / refreshSubscriptions
  // 已抽到 ./subscriptions/refresh（rescanAfterRuleChange 改经 events.emitRulesChanged 触发）。

  /* ===================== 1. 工具 ===================== */
  // 本节已全部抽到 ./util（getCookie/parseDuration/parseCount/escapeHtml）
  // 与 ./match/normalize（lc/toHalfWidth/escapeRe/INVISIBLE_RE/stripInvisible/SEP_RE/
  // normMatch/compileLines/textHit/KW_SCOPES/compileScopedKeywords/kwHit）。见顶部 import。
  // fuzzy 开关经 configureFuzzy 注入（在 CONFIG 就绪后、首次 buildMatchers 前绑定，见下）。

  /* ===================== 2. 页面模型 ===================== */
  // IS_SEARCH / IS_DYNAMIC / pageType / VIDEO_CARD_SELECTOR / cellOf / isUnsafeHideTarget 已抽到 ./page

  /* ===================== 3. 卡片信息抽取 ===================== */
  // pickText / extractCardInfo / normFeedItem 已抽到 ./cardinfo（见顶部 import）。
  // 广告/直播检测开关经 configureCardDetect 注入（见上）。

  /* ===================== 4. 规则匹配（白名单优先） ===================== */
  // 已抽到 ./match/engine：M / ruleVersion / buildMatchers / rebuildRules / isWhitelisted /
  // SYNC_DIMS / API_DIMS / matchRule / matchApi / apiNeeds / apiRulesActive / buildApiCtx（见顶部 import）。
  // 维度注册表（SYNC_DIMS/API_DIMS）即扩展点：加维度=往对应数组加一条，三处派生自动生效。

  /* ===================== 4b. 接口层（缓存 + 限速队列 + 风控熔断） ===================== */
  // 已抽到 ./api：riskGuard / fetchView / fetchTags / fetchCard / cachedUid（见顶部 import）

  /* ===================== 4c. 网络拦截层（数据层过滤，主路径） ===================== */
  // FEED_HOOKS / isFeedUrl / filterFeedJson / NET 管线 / computeFilteredText / installNetworkHooks
  // 已抽到 ./net（见顶部 import）。installShadowHook 因依赖 comments/shadow，留在 bootstrap。

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
  // PROCESSED 已抽到 ./constants
  // blockedLog / tallyLog / logBlocked / recordBlock / sessionBlocked 已抽到 ./stats（见顶部 import）
  const countedEls = new WeakSet(); // DOM 兜底「已计数」去重（属 DOM 层，留待 L4 随 dom 一起抽）
  let panelStatsRefresh = null; // 面板打开时的「屏蔽记录」刷新器（renderPanel 注册，stats 监听器读取）

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

  // recordBlock 已抽到 ./stats（命中后经 setStatsListener 回调更新角标 / 面板）

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
  // shadowRoots / harvestShadowRoots 已抽到 ./dom/shadow（见顶部 import）
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
  // CMT_TAGS / scanComments / scheduleCommentScan 等已抽到 ./comments（见顶部 import）。

  // addToList / removeFromList 已抽到 ./rules（改经 events.emitRulesChanged 通知，打断 dom↔rules 环）

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

  // updateBadge / toast / toastContainer 已抽到 ./ui/toast（见顶部 import）

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

  // splitRuleInput 已抽到 ./match/normalize（见顶部 import）

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
      setSessionBlocked(0);
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
