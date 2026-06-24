# 贡献指南 · Contributing

感谢参与 **biliHoyoFairy · 抗击黑潮**。源码是 TypeScript 多模块（`src/`），经 esbuild 打包为单文件用户脚本 `biliHoyoFairy.user.js`（仓库根）。

> 第一次改代码？先读 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)——里面有模块地图、分层依赖、注入 seam、以及「想改 X 去哪 / 怎么加新维度」的速查与 cookbook。

## 报告问题（Issue）

提交前请先搜索是否已有相同 Issue。新建时请用对应模板，并尽量提供：

- 页面类型：首页 / 热门 / 排行榜 / 搜索 / 播放页 / 动态 / 评论区
- 复现步骤（越具体越好）
- 期望行为 vs 实际行为
- 控制台日志：F12 打开后筛 `[biliHoyoFairy]`；开启面板里的「调试模式」可逐卡打印拦/放原因
- 环境：浏览器 + 版本、Tampermonkey 版本、脚本 `@version`

## 提交代码（Pull Request）

```
Fork → 新建分支(feat/xxx 或 fix/xxx) → 改 src/ → npm run build/typecheck/lint/test → 浏览器自测 → 提 PR
```

### 本地开发与测试

1. 克隆你的 fork：`git clone git@github.com:<you>/biliHoyoFairy.git`，然后 `npm install`。
2. **改 `src/` 下的模块**（不要手改根目录的 `biliHoyoFairy.user.js`，它是构建产物）。不知道改哪个文件？查 [ARCHITECTURE](docs/ARCHITECTURE.md) §6「我要改 X 去哪」。
3. 本地校验（CI 同款）：
   - `npm run build` 打包到根产物 · `npm run typecheck` · `npm run lint`（含 no-undef 安全网）· `npm test`（vitest 纯逻辑单测）
4. 把构建出的 `biliHoyoFairy.user.js` 粘进 Tampermonkey 测试（步骤见 [docs/review/SMOKE-TEST.md](docs/review/SMOKE-TEST.md)）；开「调试模式」对照控制台 `[biliHoyoFairy]` 日志，确认**无破版、无黑洞空位、无报错**。

### 代码约定

- 源码 TypeScript 模块化；核心/纯逻辑层保持**强类型、无 `@ts-nocheck`**，新增纯逻辑请配套单测；DOM/UI 层渐进类型化。
- 无外部**运行时**依赖；产物始终单文件，不引入 CDN/远程加载。
- 加过滤维度 = 往 `match/engine.ts` 的 `SYNC_DIMS`/`API_DIMS` 加一条（见 ARCHITECTURE §5）；新增联网维度必须**缓存 + 限速 + 默认关**，防风控。
- 选择器尽量健壮：优先按结构/语义向上找网格容器，避免硬编码易变 class。
- 注释只解释「为什么」，不复述「做了什么」；第三方致谢集中在 README，勿散落代码。
- 不要改 `STORE_KEY`（会导致老用户本地配置丢失）。

### 版本与发布（重要）

- `@updateURL` 指向 `main` 分支的 raw 文件——**合入 `main` = 对全体用户发布**。
- 任何对外可见的改动，请在 PR 里同步 **bump `@version`**（如 `0.0.1` → `0.0.2`），否则 Tampermonkey 不会提示用户更新。
- 维护者会在 Review + 实测通过后再合入 `main`。

## 行为准则

对事不对人，保持友善。引战、人身攻击的 Issue/PR 会被关闭。
