# 架构说明 · ARCHITECTURE

> 给**维护者/二次开发者**看的地图：项目怎么组织、数据怎么流、想改某功能该去哪个文件、怎么加新能力。
> 用户向的安装/功能说明在 [README](../README.md)；贡献流程在 [CONTRIBUTING](../CONTRIBUTING.md)。

---

## 1. 一句话

biliHoyoFairy 是一个净化 B 站推荐流的油猴脚本。源码是 **TypeScript 多模块**（`src/`），经 **esbuild 打包成单文件** `biliHoyoFairy.user.js`（仓库根，供 Tampermonkey 安装/自动更新）。

**两层过滤模型**（核心心智）：

1. **拦截层（主）**：`document-start` 时 hook `fetch`/`XHR`，在 B 站读取推荐 JSON 之前就把命中规则的项从数组里删掉 → 页面只渲染保留项（无遮罩、无留白、不重发请求、不触发风控）。
2. **DOM 兜底层（薄）**：`MutationObserver` 处理拦截层覆盖不到的（首屏 SSR、需联网取数的进阶维度、评论区），命中即安全隐藏。
3. **同一套规则**：两层共用 `matchRule` + 维度注册表，数据源不同、判定一致。
4. **一键拉黑**：调官方 `relation/modify` 写账号黑名单，刷新后不再被推荐。

---

## 2. 目录结构（每个文件一句话职责）

```
src/
├─ main.ts              入口 bootstrap：装 hook、接线注入 seam、起 observer、注册菜单（只装配，无业务逻辑）
├─ meta.js              UserScript 头部（@version 单一来源；esbuild 把它 prepend 到产物）
│
│  ── L0 纯叶子（无内部依赖，可独立单测）──
├─ constants.ts         存储键 / DOM 标记属性 / 风控码 / 内置名单（AI机器人、广告正则）
├─ util.ts              纯工具：getCookie / parseDuration / parseCount / escapeHtml
├─ page.ts              页面类型识别 + 「视频卡」选择器 + 网格格子定位
├─ events.ts            规则变更事件 seam（onRulesChanged）——打断 dom↔rules 环
├─ presets.ts           预置规则库数据（PRESET_LIBRARY）
├─ shadow.ts            开放 shadowRoot 注册表（评论/卡片穿透用）
├─ batch.ts             名单批量解析 parseNameList（粘贴的 UID/UP名 → 两组）
├─ match/normalize.ts   文本归一 + 规则行编译 + 作用域关键词 + splitRuleInput（fuzzy 注入）
├─ subscriptions/parse.ts  订阅文本解析（JSON / uBlock 文本双格式）
├─ ui/hooks.ts          UI 回调注入桥（低层模块经它回调面板，避免 import 面板成环）
├─ ui/panel.styles.ts   面板 CSS（import 副作用注入，含暗色 @media）
├─ ui/confirm.ts        样式化确认/输入弹窗 confirmModal/promptModal（替代原生 confirm/prompt；零内部依赖）
│
│  ── L1~L3 状态 / 数据 / 副作用 ──
├─ config.ts            AppConfig 类型 + CONFIG 单例 + 存取/合并/导入导出（deepMerge 原型链防护）
├─ logging.ts           log / logErr / safe（错误边界）+ BADGE
├─ cardinfo.ts          卡片信息抽取：DOM(extractCardInfo) 与接口(normFeedItem) 归一成同形 CardInfo
├─ hotsearch.ts         热搜词屏蔽（注入/移除一段 CSS）
├─ stats.ts             拦截计数 + 环形屏蔽记录 + setStatsListener（命中后回调 UI）
├─ subscriptions/store.ts   订阅缓存存取 + collectSubRules（汇总启用订阅）
├─ api.ts              接口层：风控熔断 riskGuard + 限速并发队列 + fetchView/Tags/Card
├─ match/engine.ts     ★匹配引擎：M/ruleVersion + 维度注册表 SYNC_DIMS/API_DIMS + matchRule/matchApi
├─ net.ts             ★拦截层：FEED_HOOKS + NET 管线 + filterFeedJson + fetch/XHR 钩子
│
│  ── L4~L5 领域 / DOM ──
├─ rules.ts             规则增删统一入口 addToList/removeFromList/pushUnique（改完发 events）
├─ subscriptions/refresh.ts  订阅刷新（联网拉取→解析→写缓存→发 events）
├─ comments.ts          评论区过滤（读评论组件 .__data，折叠/隐藏）
├─ dom.ts               DOM 兜底层：扫描/隐藏/审查标记/按需联网评估 + rescanAfterRuleChange
├─ blacklist.ts         一键拉黑：relation/modify + 联合投稿连带 + 顺序批量(限速+风控暂停)
│
│  ── L6+ UI ──
├─ ui/toast.ts          角标 updateBadge + 轻提示 toast
├─ ui/field.ts          通用列表字段组件（折叠/添加/批量管理/chip）+ chipModel/upModel
├─ ui/menu.ts           右键菜单 + 悬停拉黑浮层
└─ ui/panel.ts          设置面板（最大模块）：构建/渲染、各分组、预置、订阅、批量、正则测试、屏蔽记录
```

★ = 两处关键设计（匹配引擎、拦截层），改动前务必理解（见 §5 扩展点）。

---

## 3. 分层依赖图（严格自底向上，无环）

每条 import 都指向**更低层**；UI 永远不被低层直接 import（靠注入 seam 回调）。

```
L0 叶子   constants · util · page · events · presets · shadow · batch
          match/normalize · subscriptions/parse · ui/hooks · ui/panel.styles · ui/confirm
L1        config
L2        logging · cardinfo · hotsearch
L3        stats · subscriptions/store
L4        ui/toast · match/engine
L5        api · rules · subscriptions/refresh · net · comments
L6        ui/field · blacklist · dom
L7        ui/menu
L8        ui/panel
L9        main（bootstrap，装配一切）
```

**为什么无环**：原本 `dom↔rules`、`stats→面板`、`toast→面板`、`cardinfo→config`、`normalize→config` 都会成环。统统用「注入 seam」断开（见 §4）。`eslint` 的 `no-undef` 是安全网：抽模块时漏 import 会变成 lint 报错而非运行时崩。

---

## 4. 注入 seam（理解这 5 个就懂了整套接线）

低层模块需要「回调上层 / 读运行时开关」，但不能 import 上层（否则成环）。做法：低层暴露一个「注入点」，由 `main`（或 `engine`）在启动时塞入实现。

| seam | 定义处 | 谁注册（实现） | 作用 |
|---|---|---|---|
| `onRulesChanged` | `events.ts` | `main.ts` → `rescanAfterRuleChange` | `rules`/`subscriptions` 改完配置只发事件，由 DOM 层重建规则+重扫。**断 dom↔rules 环。** |
| `setStatsListener` | `stats.ts` | `main.ts` → 更新角标 + 刷新面板 | `recordBlock` 记账后回调 UI，stats 不依赖 UI。 |
| `setPanelHooks` | `ui/hooks.ts` | `main.ts` → panel 的 openPanel/refreshPanelIfOpen | 角标点击/放行等低层动作能打开/刷新面板。 |
| `configureFuzzy` | `match/normalize.ts` | `match/engine.ts`（自身加载时） | 把 `CONFIG.fuzzyMatch` 注入纯归一函数，使 normalize 保持纯 leaf。**注意时序：必须在首次 buildMatchers 前绑定。** |
| `configureCardDetect` | `cardinfo.ts` | `main.ts` | 把 `hideAd/hideLiveCard` 开关注入卡片抽取，使 cardinfo 不依赖 config。 |

---

## 5. 扩展点 Cookbook（最常见的"加功能"怎么做）

### 加一个过滤维度（本地，免联网）
改 `match/engine.ts` 的 `SYNC_DIMS` 数组，push 一条 `{ match: (i: CardInfo) => 命中原因 | null }`。`matchRule` 会自动按序短路调用——**这一处加完即在拦截层和 DOM 层同时生效**。

### 加一个过滤维度（需要读接口）
改 `match/engine.ts` 的 `API_DIMS`：`{ source, needs, active, match }`。`needs` 指明依赖哪个接口（tag/view/card），`active()` 决定是否真去拉取（省请求）。务必默认关闭、复用 `api.ts` 的缓存+限速。`apiNeeds`/`matchApi` 自动派生。

### 加一个预置规则
改 `presets.ts` 的 `PRESET_LIBRARY`，加一条 `{ cat, name, desc, rules: { 维度: [...] } }`。面板预置库自动出现。

### 加一个订阅可携带的维度
改 `subscriptions/parse.ts` 的 `SUB_DIMS`（+ 文本前缀表）。`store.collectSubRules` 与解析自动跟进。

### 加一个 feed 接口端点（拦截层覆盖新页面）
改 `net.ts` 的 `FEED_HOOKS`，加一条 `{ re: URL正则, get: (data) => 可过滤数组 }`。

### 加一个配置项
改 `config.ts`：`DEFAULT_CONFIG` 加默认值 + `AppConfig` 接口加字段。旧存档由 `deepMerge` 自动补默认，无需写迁移。面板控件用 `ui/field.bindControl` 绑定。

---

## 6. 「我要改 X，去哪」速查

| 想改的东西 | 去这里 |
|---|---|
| 某条规则怎么判命中 | `match/engine.ts`（SYNC_DIMS / API_DIMS）；文本匹配细节在 `match/normalize.ts` |
| 拦截哪些接口/页面 | `net.ts`（FEED_HOOKS） |
| 卡片信息怎么抠（标题/UP/UID…） | `cardinfo.ts` |
| 默认配置 / 配置结构 | `config.ts` |
| 设置面板长相/交互 | `ui/panel.ts`（+ `ui/panel.styles.ts` 样式、`ui/field.ts` 列表字段组件） |
| 右键菜单 / 悬停按钮 | `ui/menu.ts` |
| 一键/批量拉黑逻辑 | `blacklist.ts`（接口层在 `api.ts`） |
| 评论区过滤 | `comments.ts` |
| 风控/限速 | `api.ts`（riskGuard、队列） |
| 预置词库 | `presets.ts` |
| 订阅格式/刷新 | `subscriptions/{parse,store,refresh}.ts` |
| 角标/提示文案 | `ui/toast.ts` |
| 启动顺序/事件接线 | `main.ts` |

---

## 7. 类型现状

- **强类型（无 `@ts-nocheck`）**：核心/纯逻辑层全部——`constants/util/page/events/presets/batch/shadow/config/logging/cardinfo/hotsearch/stats/api/rules/match·{normalize,engine}/subscriptions·{parse,store,refresh}/ui·{hooks,toast,confirm,panel.styles}` 等。改这些会受完整类型检查。
- **`@ts-nocheck`（渐进类型化）**：仅限 DOM/effect/UI 密集层——`net`(fetch/XHR 猴补丁)、`dom`、`comments`(.__data)、`blacklist`(GM POST)、`ui/{panel,menu,field}`、`main`。这些仍受 `eslint no-undef` 兜底（漏 import = 报错）。

---

## 8. 构建 / 测试 / 发布

```bash
npm install
npm run build      # esbuild 打包 src/ → 仓库根 biliHoyoFairy.user.js（产物，勿手改）
npm run typecheck  # tsc --noEmit
npm run lint       # eslint（含 no-undef 安全网）
npm test           # vitest 纯逻辑单测
```

- **改代码只改 `src/`**，别手改根目录 `biliHoyoFairy.user.js`（它是构建产物，CI 有漂移校验）。
- 装油猴测试：`npm run build` 后把根产物粘进 Tampermonkey（详见 [docs/review/SMOKE-TEST.md](review/SMOKE-TEST.md)）。
- 纯逻辑加了就配套加 `tests/*.test.ts`。

---

## 9. 不变量 / 红线

- **不要改 `constants.ts` 的 `STORE_KEY`**（会丢老用户本地配置）。
- 产物**始终输出仓库根**单文件，保 `@updateURL` 自动更新链路；不引入 CDN/远程运行时加载。
- 新增联网维度必须**默认关 + 缓存 + 限速**（防风控）。
- **缓存/存档有界**：API `view/tag/card` 缓存用 `util.capMapSet` 限容；`CONFIG.uidNames` 软上限 5000。任何会随会话无界增长的结构都要设上限。
- **DOM 观察器全量 `scanAll` 是有意为之**：单卡判定由 `PROCESSED` 短路，每批仅一次原生 `querySelectorAll`；增量化会牺牲 shadow/skeleton 覆盖，无 profiling 证据前不改。
- **确认对话框一律走 `ui/confirm.confirmModal`**（Promise<boolean>），不再用原生 `confirm()`；账号写/销毁类操作传 `danger:true`。新增确认入口请沿用，勿引回原生弹窗。
- **账号拉黑必须可撤销**：拉黑成功要给撤销入口（toast 动作 / 屏蔽记录按钮），撤销走 `blacklist.unblockUp`（`relation/modify act=6`）。新增账号写操作同理。
- **自有 UI 配色集中在 `ui/panel.styles.ts`**：新增表面要同时给暗色（`@media prefers-color-scheme:dark`）覆盖，说明性文字保证 WCAG AA（≥4.5:1）。
- `@updateURL` 指向 main = 合入即发布；对外可见改动要 bump `meta.js` 的 `@version`，否则用户不会自动更新。
- 第三方致谢集中在 README，勿散落代码注释。
- **安全红线**（0.0.6 起）：`@connect` 只声明已知域（B 站 + 常见 CDN），不留 `*`；配置**导出与导入都剔除 `NON_PORTABLE`**（尤其 `subscriptions`，防分享文件注入自动联网 URL）；订阅/导入的 `/正则/` 受 `MAX_REGEX_LEN` 长度上限保护（防 ReDoS）。
- **账号写操作红线**：单条拉黑（右键/悬停）执行前必须二次确认；批量拉黑必须可停止、限速、风控自动退避；`doBlacklistMany` 批量本地屏蔽统一一次 `saveConfig+emitRulesChanged`（勿逐条重扫）。
