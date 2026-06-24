// 规则匹配引擎（白名单优先 + 维度注册表）。拦截层与 DOM 层共用同一套规则，数据源不同、判定一致。
// M（编译后的匹配器）与 ruleVersion 是共享可变状态，经 rebuildRules 重建；以 ESM 实时绑定导出，
// 其它模块 import 后读到的是最新值（切勿解构后缓存）。
import { CONFIG } from '../config';
import { compileScopedKeywords, compileLines, kwHit, textHit, lc, configureFuzzy } from './normalize';
import type { Matcher, ScopedKw } from './normalize';
import type { CardInfo } from '../cardinfo';
import { collectSubRules } from '../subscriptions/store';

// 关键时序：必须在下方首次 buildMatchers() 之前接好 fuzzy 取值器，否则初始匹配器会以 fuzzy=false 编译，
// 导致首屏（网络层过滤 + 首次扫描）对默认开启的反绕过匹配失效，直到某次 rebuildRules 才纠正。
configureFuzzy(() => CONFIG.fuzzyMatch);

// 编译后的匹配器集合：精确维度预编译成 Set、关键词/正则维度编译成 Matcher，热路径直接复用。
export interface Matchers {
  blockKw: ScopedKw;
  blockPartition: Matcher;
  allowKw: ScopedKw;
  blockTag: Matcher;
  upBio: Matcher;
  blockUidSet: Set<string>;
  blockBvidSet: Set<string>;
  blockUpNameSet: Set<string>;
  allowUidSet: Set<string>;
  allowUpNameSet: Set<string>;
  cmtKw: Matcher;
  cmtUserKw: Matcher;
  cmtUserSet: Set<string>;
  needUid: boolean;
  tagActive: boolean;
  upBioActive: boolean;
}

export function buildMatchers(): Matchers {
  // 精确匹配维度预编译成 Set，避免每张卡每次都 map/includes/some 重建数组（大黑名单下显著更快）
  const lcSet = (arr: readonly string[] | null | undefined) => new Set((arr || []).map((x) => lc(x)).filter(Boolean));
  const strSet = (arr: readonly string[] | null | undefined) => new Set((arr || []).map(String));
  // 黑名单 = 用户规则 ∪ 已启用订阅规则（订阅只并入黑名单维度，不碰白名单/开关）
  const sub: any = collectSubRules();
  const u = (dim: keyof typeof CONFIG.block) =>
    ((CONFIG.block[dim] as string[]) || []).concat((sub[dim] as string[]) || []);
  const blockUidSet = strSet(u('uids'));
  const allowUidSet = strSet(CONFIG.allow.uids);
  const blockTag = compileLines(u('tags'));
  const upBio = compileLines(u('upBio'));
  return {
    blockKw: compileScopedKeywords(u('keywords')),
    blockPartition: compileLines(u('partitions')),
    allowKw: compileScopedKeywords(CONFIG.allow.keywords),
    blockTag,
    upBio,
    blockUidSet,
    blockBvidSet: new Set(u('bvids')),
    blockUpNameSet: lcSet(u('upNames')),
    allowUidSet,
    allowUpNameSet: lcSet(CONFIG.allow.upNames),
    // 评论区维度（独立编译）
    cmtKw: compileLines(CONFIG.comment.keywords),
    cmtUserKw: compileLines(CONFIG.comment.userNameKeywords),
    cmtUserSet: lcSet(CONFIG.comment.userNames),
    // 是否存在 UID 规则：决定扫描时要不要为缺 UID 的卡做昂贵的 innerHTML 兜底解析
    needUid: blockUidSet.size > 0 || allowUidSet.size > 0,
    // API 维度是否需要拉取（含订阅并入的规则）：标签 = 仅当有专门的「视频标签」规则；简介 = 有简介词。
    // 注意：普通关键词只匹配 标题/UP名/分区（本地、免联网），不再隐式触发每张卡的标签请求。
    tagActive: !blockTag.empty,
    upBioActive: !upBio.empty,
  };
}

export let M = buildMatchers();
// 规则版本号：每次重建自增；评论扫描据此判断某条评论是否需重新评估（避免重复处理 + 规则变更后能刷新）
export let ruleVersion = 0;
export function rebuildRules(): void {
  M = buildMatchers();
  ruleVersion++;
}

export function isWhitelisted(info: CardInfo): boolean {
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

// 匹配上下文：把原始接口数据整理成 API_DIMS 共用的形状。
export interface ApiCtx {
  tags: string[];
  view: any;
  sign?: string;
}

export interface SyncDim {
  match: (i: CardInfo) => string | null;
}
export interface ApiDim {
  source: 'tag' | 'view' | 'card';
  needs: 'tag' | 'view' | 'card';
  active: () => boolean | number;
  match: (info: CardInfo, ctx: ApiCtx) => string | null;
}

// 本地同步维度（matchRule，按序短路）。各 match 自带空配置守卫，故无需 active。
export const SYNC_DIMS: SyncDim[] = [
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
export const API_DIMS: ApiDim[] = [
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

export function matchRule(info: CardInfo): string | null {
  if (isWhitelisted(info)) return null;
  for (const d of SYNC_DIMS) {
    const r = d.match(info);
    if (r) return r;
  }
  return null;
}

// 算出「联网维度」各需要哪些接口（由注册表的 active/needs 推导）。
export function apiNeeds(): { needTag: boolean; needView: boolean; needCard: boolean } {
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
// 是否有任一联网规则启用（决定要不要发请求）。
export function apiRulesActive(): boolean {
  if (!CONFIG.apiFilters) return false;
  const n = apiNeeds();
  return n.needTag || n.needView || n.needCard;
}

// 把原始接口数据整理成匹配上下文，供 API_DIMS 的 match 共用。
function buildApiCtx(info: CardInfo, view: any, tags: string[] | null | undefined, cardData: any): ApiCtx {
  const ctx: ApiCtx = { tags: tags || [], view: view || {} };
  if (cardData) {
    const c = cardData.card || cardData;
    ctx.sign = c.sign || '';
  }
  return ctx;
}

// 联网维度匹配：view=视频详情, tags=标签数组, cardData=UP卡片。
export function matchApi(info: CardInfo, view: any, tags: string[] | null | undefined, cardData: any): string | null {
  if (isWhitelisted(info)) return null; // 与 matchRule 对齐：白名单对联网维度同样优先（防新增调用点遗漏）
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
