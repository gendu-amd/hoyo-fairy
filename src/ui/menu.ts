// @ts-nocheck
// 右键菜单 + 悬停快捷拉黑浮层。右键视频卡/评论 → 屏蔽/拉黑/加白名单/隐藏；悬停卡片显示「拉黑」浮层。
// 浮层用独立 Shadow DOM，抗 B 站框架重渲染、与页面 CSS 互不污染。本层 DOM 操作密集，保留 @ts-nocheck。
import { CONFIG } from '../config';
import { PROCESSED } from '../constants';
import { VIDEO_CARD_SELECTOR } from '../page';
import { extractCardInfo } from '../cardinfo';
import { CMT_TAGS, readCmt } from '../comments';
import { blockVideo } from '../dom';
import { blacklistUp } from '../blacklist';
import { addToList } from '../rules';
import { toast } from './toast';
import { confirmModal } from './confirm';
import { refreshPanelIfOpen, openPanel } from './hooks';

// 账号拉黑是不可一键撤销的账号写操作，且与「本地屏蔽」相邻、易误点 → 执行前二次确认（样式化弹窗，Promise<boolean>）。
function confirmBlacklist(name) {
  return confirmModal(`确定拉黑「${name}」并写入账号黑名单？\n刷新后不再推荐、不可一键撤销（未登录则仅本地屏蔽）。`, {
    title: '拉黑确认',
    okText: '拉黑',
    danger: true,
  });
}

let ctxMenuEl = null;
function closeCtxMenu() {
  if (ctxMenuEl) {
    ctxMenuEl.remove();
    ctxMenuEl = null;
  }
}

export function onContextMenu(e) {
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
      label: `🚫 屏蔽 UP「${info.up}」`,
      act: () => {
        if (info.uid) addToList(CONFIG.block.uids, info.uid);
        else addToList(CONFIG.block.upNames, info.up);
        toast(`已屏蔽 UP：${info.up}`);
        refreshPanelIfOpen();
      },
    });
    items.push({
      label: `⛔ 拉黑 UP「${info.up}」（同步账号黑名单）`,
      act: () => {
        confirmBlacklist(info.up).then((ok) => {
          if (ok) blacklistUp(info, refreshPanelIfOpen, card);
        });
      },
    });
    items.push({
      label: `⭐ 加入白名单（永不屏蔽此 UP）`,
      act: () => {
        addToList(CONFIG.allow.upNames, info.up);
        toast(`已加入白名单：${info.up}`);
        refreshPanelIfOpen();
      },
    });
  }
  if (info.bvid) {
    items.push({
      label: `🚫 屏蔽此视频（${info.bvid}）`,
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

// 在鼠标处弹出自定义菜单（视频卡 / 评论 共用）。
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

// 评论在 shadow DOM 内，contextmenu 的 target 会重定向到宿主；用 composedPath 在路径上找评论组件宿主。
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
// 又让页面 CSS 与我们的样式互不污染。
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
    confirmBlacklist(info.up || info.bvid).then((ok) => {
      if (!ok) return;
      blacklistUp(info, refreshPanelIfOpen, hoverCard);
      hideHoverBtn();
    });
  };
  root.appendChild(hoverBtn);
  return hoverBtn;
}
export function hideHoverBtn() {
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
export function onCardHover(e) {
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
