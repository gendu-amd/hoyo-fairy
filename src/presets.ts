// 预置规则库 v2：内置“起步包”。每条 = { cat 大类, name, desc, rules:{维度:[...]} }，
// 点一下把 rules 各维度加进对应黑名单（多为关键词，也可投放标签等）。持续更新的大名单走「规则订阅」。

export interface Preset {
  cat: string;
  name: string;
  desc?: string;
  rules: Record<string, string[]>;
}

export const PRESET_LIBRARY: Preset[] = [
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
