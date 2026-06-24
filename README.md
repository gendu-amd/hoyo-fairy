# biliHoyoFairy · 抗击黑潮

> 凯撒命你兵分五路抗击黑潮，此乃其一。

[![Install](https://img.shields.io/badge/Tampermonkey-一键安装-fb7299)](https://raw.githubusercontent.com/gendu-amd/biliHoyoFairy/main/biliHoyoFairy.user.js)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

🛡 一个净化 B 站（bilibili）推荐流的 Tampermonkey 用户脚本：在请求推荐数据时就按你的规则把命中项删掉（**渲染前拦截**，无遮罩、无留白、无闪烁），漏网的再 **DOM 兜底**隐藏，并能**一键拉黑**同步到账号黑名单——真正让黑流量、引战、广告与不想看的 UP 从推荐流消失。

覆盖 **首页 / 热门 / 排行榜 / 搜索 / 播放页推荐 / 动态 / 评论区**，兼容 **Edge / Chrome / Firefox**（装 Tampermonkey 即可，无需单独扩展）。当前为 **pre-release v0.0.6**。

## 目录

- [界面预览](#界面预览)
- [为什么需要它](#为什么需要它)
- [功能](#功能)
- [安装](#安装)
- [使用](#使用)
- [注意事项](#注意事项)
- [路线图](#路线图)
- [参与开发](#参与开发)
- [致谢](#致谢)

## 界面预览

同一信息流，**关脚本 vs 开脚本**：

![拦截前后对比](https://github.com/user-attachments/assets/49cb7653-931d-407d-9369-ac65e018b8f9)

<table>
<tr>
<td width="33%" valign="top"><b>设置面板</b><br>分组即改即生效<br><br><img alt="设置面板" src="https://github.com/user-attachments/assets/73b25954-3bd7-49d1-a002-6e354043db3d"></td>
<td width="33%" valign="top"><b>屏蔽记录</b><br>分类统计 + 来源徽章 + 放行<br><br><img alt="屏蔽记录" src="https://github.com/user-attachments/assets/4a2148cb-785a-42ad-9362-b4506ea2176f"></td>
<td width="33%" valign="top"><b>评论区过滤</b><br>引战 / 水军 / 营销评论<br><br><img alt="评论区过滤" src="https://github.com/user-attachments/assets/b0ea0c59-1a6d-46e8-a121-321339777d2c"></td>
</tr>
</table>

## 为什么需要它

B 站自带的「关键词屏蔽 / 不感兴趣」只在展示环节藏标题命中的卡片，不回流推荐模型，刷新即复现，也没有真正关闭个性化推荐的开关。本脚本不依赖平台善意，在浏览器端对推荐流做硬过滤，并用一键拉黑写入账号黑名单，让烦人内容刷新后也不再被推荐。

## 功能

| 能力 | 说明 | 默认 |
| --- | --- | :---: |
| 关键词 / 分区 / UP / UID / BV | 多维精准屏蔽；支持 `/正则/`、`title:`·`up:`·`part:` 作用域、全角归一 | 按需 |
| 反绕过匹配 | 剔除隐形字符;模糊匹配让「原 神 / 原.神」也命中 | 开 |
| 时长 / 播放量 | 按秒数区间、播放量阈值过滤 | 按需 |
| 营销号识别 | 高播放 + 极低点赞率(搬运/营销号特征)自动屏蔽，阈值可调 | 关 |
| 广告卡 / 直播推荐卡 / 热搜词 | 卡片类型一键屏蔽 | 关 |
| 白名单优先 | 关键词 / UP / UID，命中永不隐藏，防误伤 | — |
| 一键拉黑 | 右键 / 悬停 / 批量，调官方接口同步账号黑名单 | — |
| 名单批量处理 | 粘贴 / 文件 / URL 导入一批 UID 或 UP 名（空格·逗号·换行·分号分隔）→ 仅屏蔽 或 一键拉黑 | — |
| 审查模式 / 屏蔽记录 / 正则测试器 | 命中描边标记、就地放行、分类统计；面板内调试正则 | — |
| 预置规则库 | 按大类（游戏黑水 / 引战 / 标题党·营销 / 其它）一键灌词，可多维度、可叠加 | — |
| 评论区过滤 | 关键词 / 用户名 / 等级 / 水军特征 / AI / 带货；命中可折叠（点击展开）；UP·置顶·自己 白名单 | 关 |
| 进阶（联网） | 视频标签 / 双标签治引战 / UP 简介 / 充电专属（缓存 + 限速 + 风控熔断） | 关 |
| 导入 / 导出 | 规则与开关备份、分享、合并去重 | — |
| 规则订阅 | 从 URL 拉取社区黑名单并自动合并刷新（JSON / 文本双格式） | 按需 |

> 各功能的稳定 / 待验证状态见 [路线图](#路线图)；规则仅存浏览器本地（`GM_setValue`），不外传。规则订阅格式（JSON / 文本）见 [`examples/`](examples/)。

<details>
<summary>工作原理（拦截优先 + DOM 兜底）</summary>

- **拦截层（主）**：`document-start` 时 hook `fetch` / `XHR`，在 B 站读取推荐 / 排行 / 热门 / 搜索 / 相关推荐的 JSON 之前删掉命中项，页面只渲染保留项——不重发请求、不需 WBI 签名、不触发风控。
- **DOM 兜底层**：用 `MutationObserver` 处理拦截层覆盖不到的部分（首屏 SSR、动态、需联网取数的进阶维度、评论区），命中即安全隐藏；单卡处理有错误边界，异形卡不会中断整轮扫描。
- **一键拉黑**：调用官方 `/x/relation/modify (act=5)` 写入账号黑名单，刷新后不再被推荐（未登录则仅本地屏蔽）。
- 拦截层与 DOM 层**共用同一套规则**（白名单优先 + 维度注册表），数据源不同、判定一致。

</details>

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展。
2. **Edge 用户**：在 `edge://extensions/` 启用「开发人员模式」（否则 MV3 下用户脚本可能不生效）。
3. 安装脚本并在弹出页确认：
   - **GitHub**：[安装](https://raw.githubusercontent.com/gendu-amd/biliHoyoFairy/main/biliHoyoFairy.user.js)
   - **Greasy Fork**（国内 / 打不开 GitHub 推荐）：[安装](https://greasyfork.org/zh-CN/scripts/582873)
4. 打开 [bilibili.com](https://www.bilibili.com/)，右下角出现 🛡 角标即成功。

> 自 `v0.0.2` 起恢复正常版本号递增，Tampermonkey 会在 `@version` 升高时自动更新（GitHub raw 有约 5 分钟 CDN 缓存）。

## 使用

1. 点右下角 🛡 角标打开面板（分组：基础 / 黑名单 / 进阶 / 评论 / 白名单 / 工具，**即改即生效，无需保存**）。
2. **最快上手**：在「工具」点预置规则库按钮（如 `+ 库洛系(鸣潮/库洛)`），整组规则立即加入对应黑名单生效（之后可在「黑名单」页增删）。
3. **手动加规则**：输入框打字 → 「添加」或回车，关键词支持 `/正则/` 与 `title:`·`up:`·`part:` 前缀。
4. **右键操作**：在卡片或评论用户名上右键 → 屏蔽 / 拉黑 / 加白名单。
5. **真·移除**：对反复出现的 UP 选「拉黑」，刷新后不再被推荐；喜欢的加白名单防误伤。
6. **排查**：开「调试模式」看控制台 `[biliHoyoFairy]` 日志，或在「屏蔽记录」核对实际拦截的内容。

## 规则订阅与多人协作

规则订阅让你从一个公开 URL 自动拉取并合并黑名单，多人可共享同一份名单、由维护者统一更新。

**订阅一份名单（使用方）**

1. 在面板「工具 → 规则订阅」粘贴名单的 **raw URL** → 添加。
2. 启用后按文件中 `expires` 声明的周期自动刷新；订阅只并入黑名单，不影响你的白名单与开关。
3. 非 B 站 / 非内置 CDN（GitHub Raw、jsDelivr、Gitee）域名首次拉取时，Tampermonkey 会弹一次性授权，选「总是允许」即可。

**自建 / 共享一份名单（维护方）**

1. 复制本仓库 [`examples/`](examples/) 里的模板，二选一：
   - JSON 格式：[`examples/blocklist.example.json`](examples/blocklist.example.json)
   - 文本格式（uBlock 风格，更易手写）：[`examples/blocklist.example.txt`](examples/blocklist.example.txt)
2. 按模板改成你的名单（`expires` 控制刷新周期，如 `1d`、`12h`），推送到公开仓库。
3. 把它的 **raw URL** 分享出去即可，形如：
   `https://raw.githubusercontent.com/<用户名>/<仓库>/main/<文件名>`
   本仓库示例可直接订阅试用：
   `https://raw.githubusercontent.com/gendu-amd/biliHoyoFairy/main/examples/blocklist.example.json`

**协作维护**

- 一个公开仓库 + 一份共享名单 = 一个社区黑名单源。想贡献的人 Fork 后向名单追加条目并提 PR，维护者合并后，**所有订阅者会在下次刷新时自动获得更新**，无需各自手动同步。
- 可同时订阅多份（如「引战」「营销号」分主题各一份），规则自动合并去重。
- 格式细节（前缀、各维度是否支持正则等）见两个模板文件内的注释。

## 注意事项

- 不要同时启用多个 B 站屏蔽类脚本，否则会争抢 DOM 导致行为错乱。
- 请使用无后缀首页 `https://www.bilibili.com/`（带 `index.html` 的可能不生效）。
- Chromium 内核建议版本 ≥ 105。
- 一键拉黑依赖登录态（读取 `bili_jct` Cookie）；未登录时仅本地拦截。账号拉黑可在「屏蔽记录」或拉黑后的提示里**一键撤销**。
- 评论区 / 直播卡过滤默认关闭，按需开启；B 站前端改版可能使选择器失效，届时更新脚本即可。
- 评论命中默认**折叠成一行**（点击展开），可在「评论」设置里关掉改为直接隐藏。
- **关键词只匹配 标题 / UP 名 / 分区（纯本地）**，不再匹配视频标签；要按标签拦截请用「视频标签」维度并开启「精确过滤」。点含标签 / 简介维度的预置时，若未开精确过滤会提示一键开启。
- **订阅 / 名单 URL 的域名授权**：脚本只预声明了 B 站与常见 CDN（GitHub Raw / jsDelivr / Gitee）域名。从**其它域名**加订阅或「从 URL 载入」名单时，Tampermonkey 会弹一次性授权确认，选「总是允许」即可正常拉取（这是收窄默认网络权限带来的正常提示）。
- 面板会跟随系统**暗色模式**；支持键盘操作（`Esc` 关闭面板、`Enter`/`Esc` 确认/取消弹窗）。

## 隐私与数据

本脚本完全在你的浏览器本地运行，**没有任何自有服务器**：

- **读取**：仅读取 `bili_jct` Cookie，且只用于调用 B 站官方接口（拉黑/取消拉黑）所需的 CSRF 校验，不外传。
- **存储**：规则、开关、订阅列表、拦截计数、UP 名缓存（`uidNames`）均通过油猴 `GM_setValue` 存在**本地**；导出配置时会自动剔除 `uidNames`/统计/订阅等不可移植数据。
- **联网**：仅向 `api.bilibili.com`（取数/拉黑）和你**自己添加**的订阅源发起请求；除此之外不向任何第三方发送数据。
- **账号写操作**：仅「一键拉黑」会调用官方 `relation/modify` 写入你的账号黑名单，执行前二次确认、且可一键撤销。

## 路线图

已实现（欢迎在 Issue 反馈）：

- [x] 信息流直播推荐卡过滤
- [x] 评论区过滤（关键词 / 用户名 / 等级 / 水军 / AI / 带货 + 白名单）
- [x] 进阶联网维度（视频标签 / 双标签 / UP 简介 / 充电专属）
- [x] 批量拉黑 / 联合投稿连带拉黑 / 一键撤销
- [x] 导入 / 导出、增大首页加载
- [x] 规则订阅（远程黑名单拉取 / 合并 / 自动刷新，JSON 与文本双格式）
- [x] 反绕过匹配（隐形字符剔除 + 分隔符模糊匹配）
- [x] 营销号识别（高播放 + 低点赞率启发式，阈值待真机调优）
- [x] 风控熔断（联网触发风控时自动退避）
- [x] 预置规则库 v2（按大类分组 / 多维度 / 一键叠加）
- [x] 评论命中折叠（一行灰条，点击展开真评论）
- [x] 暗色模式 / 键盘可达性 / 样式化确认弹窗

计划中、尚未实现：

- [ ] 拼音 / 简繁自动匹配（需内嵌字表，评估中；当前可用正则覆盖）
- [ ] 直播间 / 个人空间页扩展
- [ ] 跨标签页配置实时同步

已评估、不做：

- 「不感兴趣 / 点踩」自动喂负反馈：B 站点踩为 App 专属接口（需扫码登录拿 `access_key`），网页端无法可靠实现且服务端反馈延迟极大，**性价比过低，放弃**。

## 参与开发

欢迎提 Issue 反馈 bug / 建议，或提 Pull Request。完整流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

- **想读懂代码 / 二次开发**：先看 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)——模块地图、分层依赖、注入 seam，以及「想改 X 去哪 / 怎么加新过滤维度·预置·订阅维度」的速查与 cookbook。
- 源码在 `src/`（TypeScript 多模块），`npm run build` 用 esbuild 打包成根目录单文件 `biliHoyoFairy.user.js`（**别手改产物**）。
- 报告问题：用 [Issue 模板](.github/ISSUE_TEMPLATE/) 提交，附页面类型、复现步骤、控制台 `[biliHoyoFairy]` 日志（开调试模式更易定位）。
- 本地测试：`npm run build` 后把根产物粘进 Tampermonkey 安装 / 覆盖，刷新 B 站验证（详见 [冒烟清单](docs/review/SMOKE-TEST.md)）。
- 发布：`@updateURL` 指向 `main` 分支，**仅在 `@version` 升高时**触发用户自动更新，故对外改动务必同步 +1。

## 致谢

设计调研并借鉴了以下成熟方案：

- [tjxwork · 按标签/标题/时长/UP主屏蔽视频](https://greasyfork.org/zh-CN/scripts/481629)：多维过滤思路与防风控请求框架。
- [festoney8/bilibili-cleaner](https://github.com/festoney8/bilibili-cleaner)：黑白名单分离、可插拔 fetch 管线、关键词归一、评论区数据读取。
- [codertesla/bilibili-1-click-blocker](https://github.com/codertesla/bilibili-1-click-blocker)：一键拉黑交互与 Shadow DOM 浮层思路。

## License

[MIT](LICENSE)
