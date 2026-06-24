// UserScript 元数据（构建产物的头部）。版本号单一来源在此处维护。
// scripts/build.mjs 会把 banner 原样 prepend 到打包产物 biliHoyoFairy.user.js。
export const version = '0.0.6';

export const banner = `// ==UserScript==
// @name         B站(bilibili)推荐流净化·屏蔽拉黑去广告 — biliHoyoFairy 抗击黑潮
// @name:zh-CN   B站(bilibili)推荐流净化·屏蔽拉黑去广告 — biliHoyoFairy 抗击黑潮
// @name:en      biliHoyoFairy — bilibili Feed Cleaner, Blocker & Account Blacklist
// @namespace    https://github.com/gendu-amd/biliHoyoFairy
// @version      ${version}
// @description  B站(bilibili/哔哩哔哩)推荐流净化与屏蔽脚本：屏蔽黑流量、引战视频、商业广告与不想看的 UP 主。支持按 标签/UP主/UID/关键词(可正则)/分区/时长/播放量/BV 精准过滤；覆盖首页/热门/排行榜/搜索/播放页/动态/评论区；白名单优先防误伤；右键一键屏蔽/拉黑(同步账号黑名单)；内置预置关键词库与规则订阅。
// @description:en  Clean up & block the bilibili recommendation feed: hide clickbait, flame-bait, ads and unwanted UP owners. Filter by tag/UP/UID/keyword(regex)/category/duration/views/BV across home, popular, ranking, search, video, dynamic pages and comments; whitelist priority; one-click block synced to the account blacklist; preset keyword library and rule subscriptions.
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
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-start
// @license      MIT
// ==/UserScript==
`;
