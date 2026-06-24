// @ts-nocheck
// 设置面板（UI 最大模块）：注入 CSS + 构建/渲染面板——分组 Tab、列表字段、预置库、规则订阅、
// 名单批量处理/批量拉黑、正则测试器、导入导出、屏蔽记录等。DOM 操作密集，保留 @ts-nocheck（渐进类型化）。
import { CONFIG, DEFAULT_CONFIG, saveConfig, exportConfig, mergeImport, NON_PORTABLE } from '../config';
import { PRESET_LIBRARY } from '../presets';
import { VERSION, BLACKLIST_MANAGE_URL, ATTR_BLOCKED } from '../constants';
import { pageType } from '../page';
import { escapeHtml } from '../util';
import { escapeRe } from '../match/normalize';
import { blockedLog, tallyLog, sessionBlocked, setSessionBlocked } from '../stats';
import { blacklistUp, doBlacklistMany, REL_ERR } from '../blacklist';
import { refreshSubscriptions, syncSubscription, metaGet } from '../subscriptions/refresh';
import { loadSubStore, saveSubStore } from '../subscriptions/store';
import { rescanAfterRuleChange } from '../dom';
import { addToList, pushUnique } from '../rules';
import { parseNameList } from '../batch';
import { extractCardInfo } from '../cardinfo';
import { fetchView, cachedUid } from '../api';
import { applyHotSearchStyle } from '../hotsearch';
import { toast, updateBadge } from './toast';
import { renderListField, chipModel, bindControl, renderFields } from './field';
import { hideHoverBtn } from './menu';
import './panel.styles';

let panelStatsRefresh = null; // 面板打开时的「屏蔽记录」刷新器（renderPanel 注册，stats 监听器读取）

  // CSS 注入已抽到 ./panel.styles（见上 import）

  // updateBadge / toast / toastContainer 已抽到 ./ui/toast（见顶部 import）

  // 记住当前激活的分组 Tab（renderPanel 重建时保留）
  let activeTab = 'base';

  // renderListField / chipModel / upModel / bindControl / renderFields 已抽到 ./ui/field（见顶部 import）

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
        n += pushUnique(arr, p2.rules[dim].map((v) => String(v).trim()).filter(Boolean));
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
            // 安全：导入侧同样剔除不可移植键（尤其 subscriptions——防止别人的「规则文件」悄悄塞入会自动联网的订阅 URL）
            NON_PORTABLE.forEach((k) => delete incoming[k]);
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
    // 解析输入名单（纯逻辑已抽到 ./batch.parseNameList）
    const parseList = () => parseNameList(listTa.value);
    // 仅屏蔽：UID→block.uids，名称→block.upNames（批量去重，最后统一存盘+重扫，避免逐条重扫）
    const addLocalMany = (uids, names) => {
      const n = pushUnique(CONFIG.block.uids, uids) + pushUnique(CONFIG.block.upNames, names);
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
          // 超链接：UP 名 → 空间页（有 UID 才链）；标题/描述 → 视频页（有 BV 用 BV，否则用落地页，仅 http(s)）。
          // 跳转 URL 经 encodeURIComponent / 白名单 http(s) 校验 + escapeHtml 属性转义，杜绝 javascript: 等注入。
          const safeHttp = (u) => (u && /^https?:\/\//i.test(u) ? u : '');
          const upHref = b.uid ? 'https://space.bilibili.com/' + encodeURIComponent(b.uid) : '';
          const vidHref = b.bvid ? 'https://www.bilibili.com/video/' + encodeURIComponent(b.bvid) : safeHttp(b.link);
          const A = (href, inner) => `<a class="log-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
          const upHtml = b.up ? (upHref ? A(upHref, '<b>' + escapeHtml(b.up) + '</b>') : '<b>' + escapeHtml(b.up) + '</b>') + ' · ' : '';
          const descHtml = vidHref ? A(vidHref, escapeHtml(desc)) : escapeHtml(desc);
          tx.innerHTML = `${srcTag}<span class="log-rs">[${escapeHtml(b.reason)}]</span> ${upHtml}${descHtml}`;
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
  export function openPanel() {
    buildPanel();
    const p = panelEl();
    renderPanel(p);
    p.classList.add('open');
  }
  function closePanel() {
    const p = panelEl();
    if (p) p.classList.remove('open');
  }
  export function refreshPanelIfOpen() {
    if (!isPanelOpen()) return;
    renderPanel(panelEl());
  }

// 命中记账后由 stats 监听器调用：面板打开时刷新「屏蔽记录」计数（角标更新在 main 里另做）。
export function refreshStatsIfOpen() {
  if (panelStatsRefresh && isPanelOpen()) panelStatsRefresh();
}
// 内部辅助 buildPanel / renderPanel / panelEl / isPanelOpen / closePanel 不对外导出（仅本模块使用）。
