// @ts-nocheck
// 入口 bootstrap：在 document-start 安装拦截层 + shadow 钩子，文档就绪后启动 DOM 兜底/评论扫描，
// 接线各模块的注入 seam（面板回调 / stats 监听 / 规则变更 / 卡片检测开关），注册菜单命令与 MutationObserver。
// 业务逻辑全部在各 src 模块；本文件只负责装配。仍保留 @ts-nocheck（事件 glue，渐进类型化），但受 eslint(no-undef) 约束。
// bootstrap 只依赖各模块的「入口/接线」符号；其余模块经依赖图传递性加载（无需在此直接 import）。
import { VERSION, BLACKLIST_MANAGE_URL } from './constants';
import { CONFIG, saveConfig } from './config';
import { safe, BADGE } from './logging';
import { configureCardDetect } from './cardinfo';
import { pageType } from './page';
import { installNetworkHooks } from './net';
import { shadowRoots, harvestShadowRoots } from './shadow';
import { sessionBlocked, tallyLog, setStatsListener } from './stats';
import { updateBadge, toast } from './ui/toast';
import { setPanelHooks } from './ui/hooks';
import { refreshSubscriptions } from './subscriptions/refresh';
import { setRulesChangedHandler } from './events';
import { CMT_TAGS, scanComments, scheduleCommentScan } from './comments';
import { applyHotSearchStyle } from './hotsearch';
import { scanAll, rescanAfterRuleChange } from './dom';
import { onContextMenu, onCardHover, hideHoverBtn } from './ui/menu';
import { openPanel, refreshPanelIfOpen, refreshStatsIfOpen } from './ui/panel';
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
  });
  // stats 命中记账后回调：更新角标 + 面板打开时刷新计数（document.body 未就绪时跳过角标）。
  setStatsListener(() => {
    if (document.body) updateBadge();
    refreshStatsIfOpen();
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

  /* ===================== 5. 拦截执行（DOM 兜底层） ===================== */
  // clearVisual / markCard / blockVideo / processCard / evaluateApi / queryCards / scanAll /
  // rescanAfterRuleChange / countedEls 已抽到 ./dom（见顶部 import）。
  // panelStatsRefresh 已随 ./ui/panel 内化；stats 监听器经 refreshStatsIfOpen() 刷新面板计数。

  /* ===================== 5c. 评论区过滤（读评论组件 __data，DOM 层隐藏） ===================== */
  // CMT_TAGS / scanComments / scheduleCommentScan 等已抽到 ./comments（见顶部 import）。

  // addToList / removeFromList 已抽到 ./rules（改经 events.emitRulesChanged 通知，打断 dom↔rules 环）

  /* ===================== 6. 一键拉黑（relation/modify act=5） ===================== */
  // resolveUidByBvid / REL_ERR / doBlacklist / doBlacklistMany / blacklistUp 已抽到 ./blacklist（见顶部 import）

  /* ===================== 7. 右键菜单 + 悬停拉黑浮层 ===================== */
  // onContextMenu / onCardHover / hideHoverBtn 等已抽到 ./ui/menu（见顶部 import）。

  /* ===================== 8. UI 面板 ===================== */
  // 已抽到 ./ui/panel：buildPanel / renderPanel / openPanel / closePanel / isPanelOpen /
  // refreshPanelIfOpen / refreshStatsIfOpen（CSS 注入、分组、列表字段、预置、订阅、批量、记录等）。

  /* ===================== 9. 热搜屏蔽 ===================== */
  // HOTSEARCH_SELECTORS / applyHotSearchStyle 已抽到 ./hotsearch（见顶部 import）

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
