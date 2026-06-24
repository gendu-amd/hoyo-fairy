// 全局常量：存储键、DOM 标记属性、风控码、内置名单等。纯数据、无副作用、无依赖（L0 叶子）。

// 单一来源：直接读脚本头 @version，避免与常量双写漂移。
export const VERSION: string =
  (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '0.0.1';

export const STORE_KEY = 'bfb_config_v2';
// 订阅拉取结果缓存：{ [url]: { meta, rules, lastSync, ok, count, error } }
export const SUB_STORE_KEY = 'bfb_subs_v1';
export const BLACKLIST_MANAGE_URL = 'https://account.bilibili.com/account/blacklist';

// DOM 标记属性（集中常量，避免散落硬编码改一处漏一处）。
export const ATTR_API = 'data-bfb-api'; // 卡片已发起 API 评估
export const ATTR_BLOCKED = 'data-bfb-blocked'; // 卡片已被拦截（供批量拉黑扫描）
export const PROCESSED = 'data-bfb-done'; // 卡片已处理标记

// 评论区已知 AI 机器人账号名单。
export const COMMENT_BOTS = new Set<string>([
  '机器工具人', '有趣的程序员', 'AI视频小助理', 'AI视频小助理总结一下', 'AI笔记侠', 'AI视频助手',
  '哔哩哔理点赞姬', '课代表猫', 'AI课代表呀', '木几萌Moe', '星崽丨StarZai', 'AI沈阳美食家', 'AI头脑风暴',
  'GPT_5', 'Juice_AI', 'AI全文总结', 'AI视频总结', 'AI总结视频', 'AI工具集', 'Ai的评论', 'AI识片酱',
  'AI知识总结', 'AI小精灵呀', 'AI课程教学', 'Ai好记', 'MilkyAi', '视频AI问答助手',
]);
// 带货/导流广告评论特征。
export const COMMENT_AD_RE = /(bili2233\.cn|b23\.tv)\/(mall-|cm-)|领券|gaoneng\.bilibili\.com/i;

// 合并外部数据（存档/导入）时必须跳过这些键，否则 JSON.parse 出来的 own "__proto__"
// 会被写进 Object.prototype，污染全局并可能破坏 B 站自身脚本。
export const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// B 站风控返回码：触发后全局退避保护账号（校验失败/被拦截/请求过频）。
export const RISK_CODES = new Set<number>([-352, -412, -509, -799]);
