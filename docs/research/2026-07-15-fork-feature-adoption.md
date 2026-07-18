# Shuai-S/metapi 与 qingdeng888/metapi-qing 功能审计及吸收建议

> 审计日期：2026-07-15
>
> 审计基线：[`iazhan/metapi-plus@512517d`](https://github.com/iazhan/metapi-plus/commit/512517d2ee102bdbb236fb7488f43dcf42a6b793)，版本 `2.0.3`
>
> 结论摘要：没有可直接整分支合并的代码；本轮已按当前架构重写并吸收“新站点检测使用表单代理”“账号列表搜索”和“站点级 additive 模型别名”。其余候选要么当前已覆盖，要么只能保留产品概念后另行设计。

## 本轮吸收结果

| 能力 | 实际落地 | 与 fork 的关键差异 |
| --- | --- | --- |
| 代理感知的站点检测 | 表单中未保存的 HTTP(S)、SOCKS 或系统代理会贯穿 adapter 与 title-hint 检测，并共享 10 秒 deadline | 复用现有代理边界；畸形凭据直接拒绝，错误不回显代理凭据，不会静默降级直连 |
| 账号列表搜索 | 桌面和移动端可按账号、站点、状态、ID 搜索；全选和批量操作只作用于过滤结果 | 批量删除确认会冻结目标 ID，后续筛选变化不会改变删除对象 |
| 站点级模型别名 | 原始模型保留，别名额外暴露；真实来源模型保存在通道上；支持多站点聚合 | 增加冲突、拼写、链/环校验，只读派生路由，别名替换与路由投影在单一事务中完成 |
| 下游密钥参数整理 | 明确“归属分组/标签”只用于管理归类，“精确模型/路由群组”按并集授权，空权限为 deny-all | 新建密钥只默认授权当前启用路由，不采用 fork 的物化 `autoSyncRoutes` |

本轮应用版本准备为 `2.1.0`，备份格式升级为 `2.3`。此处只记录本地吸收状态；尚未推送、打标签或发布。

路由投影、人工路由写入和账号备份恢复已在单个服务进程内统一串行，并将相关跨表写入放入事务、在提交后失效路由缓存。当前协调器不是数据库级分布式锁；多副本共享 MySQL/Postgres 时应保持单写，数据库 advisory lock 或等价机制需在正式支持多写实例前另行实现和验证。

## 1. 范围与方法

本次只读审计以下一手材料：

- 两个 fork 的 GitHub 分支、比较页、提交补丁、源码、迁移、测试和 Actions 状态；
- 当前仓库对应的站点检测、账号、模型发现、路由、下游密钥、备份、跨方言 schema 和发布流程；
- 每个候选按“当前是否已有、是否能 cherry-pick、是否需要重写、是否不建议采纳”分类。

没有把 README/提交标题当作功能成立的证据；结论以最终分支代码为准。审计阶段没有运行两个 fork 的测试，也没有修改或覆盖当前工作树中已有的用户改动；后续本地吸收实现使用当前仓库自己的测试、类型、schema 和构建门禁验证。

## 2. 分支基线与可信度

| 仓库 | 默认分支事实 | 实际审计分支 | 相对当前 HEAD | 发布/验证证据 |
| --- | --- | --- | --- | --- |
| [Shuai-S/metapi](https://github.com/Shuai-S/metapi) | 默认 `main=e72d19e`，没有该开发者的个人改动 | [`my-main`](https://github.com/Shuai-S/metapi/compare/main...my-main)，领先默认分支 13 commits | 当前侧领先 31，Shuai 侧领先 13，共同祖先 `e72d19e` | 无 tag、Release、PR；继承 CI 只监听 `main/master`，[自建 Docker workflow](https://github.com/Shuai-S/metapi/commit/b0d55c089b41052423d86ecce990279f28764c2a) 只证明 Web/Server 可构建，不等于完整测试、类型和 schema parity 通过 |
| [qingdeng888/metapi-qing](https://github.com/qingdeng888/metapi-qing) | 默认 [`main=e72d19e`](https://github.com/qingdeng888/metapi-qing/commit/e72d19e235289bd56be8aeb9166de82195db5e1e)，没有该开发者的个人改动 | 递进分支为 [`dev`](https://github.com/qingdeng888/metapi-qing/compare/main...dev) -> [`dev2b`](https://github.com/qingdeng888/metapi-qing/compare/main...dev2b) -> [`20260712`](https://github.com/qingdeng888/metapi-qing/compare/main...20260712) -> [`20260711`](https://github.com/qingdeng888/metapi-qing/compare/main...20260711)；最终审计 `20260711`，领先 21 commits | 当前侧领先 31，qing 侧领先 21，共同祖先 `e72d19e` | [无 Release](https://github.com/qingdeng888/metapi-qing/releases)、无 PR/issue、定制分支提交无完整 CI status；`git diff --check main..20260711` 还存在 trailing whitespace |

两个 fork 都不是“当前仓库上再加几个提交”。当前 HEAD 已在 [`de84eee`](https://github.com/iazhan/metapi-plus/commit/de84eeea812447cee1a8fbc1598921bb0a4cbe8a) 移除 native OAuth connections，并重构了路由、平台、schema 和发布链路；fork 中仍修改 Codex/Claude/Gemini CLI/Antigravity OAuth 分支或占用旧迁移编号的补丁不能直接移植。

## 3. Shuai-S/metapi：新增功能与后续修复

### 3.1 功能清单

| 提交/主题 | 最终行为 | 当前仓库对照 | 判断 |
| --- | --- | --- | --- |
| [`2023b857`](https://github.com/Shuai-S/metapi/commit/2023b857db4f4846660f24a9b333abcb42754b41)：代理感知的站点检测 | `/api/sites/detect` 和 adapter/title-hint 检测接收 `proxyUrl/useSystemProxy`；同提交还加入账号关键词过滤、批量操作只作用于可见结果、SiteBadgeLink 外链 | 当前站点可保存代理，但检测端仍只调用 [`detectSite(url)`](https://github.com/iazhan/metapi-plus/blob/512517d2ee102bdbb236fb7488f43dcf42a6b793/src/server/routes/api/sites.ts#L988-L999)，Web API 也只发送 URL。账号页已有“全选可见项”，但没有关键词搜索 | **部分采纳，手工重写**：代理检测和账号搜索拆成两个独立改动；不带入 SiteBadgeLink 语义变化 |
| [`b0d55c0`](https://github.com/Shuai-S/metapi/commit/b0d55c089b41052423d86ecce990279f28764c2a)：GHCR Docker 构建 | `my-main` 推送构建 amd64，tag 构建 amd64/arm64 | 当前已有更完整的 CI/release 多架构镜像链路，[`e72b282`](https://github.com/iazhan/metapi-plus/commit/e72b282704ed233fa95734aa64bb92227b8eed1f) | 已覆盖，不采纳 |
| [`2e24a10`](https://github.com/Shuai-S/metapi/commit/2e24a1074310cb040199049ccf9bccd67acaf3c3)：Sub2API 密码登录 | 调 `/api/v1/auth/login`，保存 refresh token 和 expiry | 当前 [`011ed14`](https://github.com/iazhan/metapi-plus/commit/011ed140551b5ae2850a644e7286e92df500db3c) 已有更完整的 2FA 拒绝、managed refresh、singleflight、scheduler/CAS、密码恢复与倍率同步 | 已覆盖，不采纳 |
| [`aada614`](https://github.com/Shuai-S/metapi/commit/aada614e02bbfa15104acf81054c68cbae40b369)：站点/账号备注 | `sites`、`accounts` 增加 `remark`，同步创建、编辑、搜索、列表和备份 | 当前没有独立备注字段 | **可采纳但必须重写**；旧迁移号冲突，且该提交没有新增行为测试 |
| [`e155b1f`](https://github.com/Shuai-S/metapi/commit/e155b1f435faab89e124a495c01f7dbeb44b4d14)：Token 分组元数据 | NewAPI/Sub2API 分组名、ID、倍率进入 `extraConfig` 并在 Token UI 展示 | 当前已用独立 `account_group_rates`/rules 和同步服务管理，[服务](https://github.com/iazhan/metapi-plus/blob/512517d2ee102bdbb236fb7488f43dcf42a6b793/src/server/services/accountGroupRateService.ts) 与 [展示层](https://github.com/iazhan/metapi-plus/blob/512517d2ee102bdbb236fb7488f43dcf42a6b793/src/web/pages/helpers/tokenGroupPresentation.ts) 更深 | 已覆盖，不采纳 fork 的 `extraConfig` 第二事实源 |
| [`b5ffaa5`](https://github.com/Shuai-S/metapi/commit/b5ffaa55e731034e1d1a5ad1336ca0e87f72c348) + [`b866556`](https://github.com/Shuai-S/metapi/commit/b866556194f1d167deff0b02ad2c1e1ff628cd53)：编辑连接类型 | 已有账号可在 Session/API Token/Password 间转换；后续避免无新 Token 时清空旧值，并统一文案 | 当前账号密码登录会按 `(siteId, username)` 原地 upsert，常见的 Session -> Password 托管已可隐式完成；缺的是按明确 account ID 转换，空用户名/大小写不同的 API Key 连接可能新建重复行，[现有流程](https://github.com/iazhan/metapi-plus/blob/512517d2ee102bdbb236fb7488f43dcf42a6b793/src/server/routes/api/accounts.ts#L488-L632) | 保留为 P2 UX 能力；应使用独立 ID 定向的 rebind-password endpoint，不把登录、Token 发现塞入通用 PUT route，也不要让前端回写整份 `extraConfig` |
| [`2ccc6cc`](https://github.com/Shuai-S/metapi/commit/2ccc6cc8d28e6e10b0ddddefc08d0f52644f85c7)：编辑 `platformUserId` | 普通账号编辑面板可修改用户 ID | 当前 create/rebind 支持，普通 update contract 不支持；[证据](https://github.com/iazhan/metapi-plus/blob/512517d2ee102bdbb236fb7488f43dcf42a6b793/src/server/contracts/accountsRoutePayloads.ts#L18-L42) | 可采纳，但应在服务端 typed merge `platformUserId: number | null`，禁止前端覆盖完整 `extraConfig` |
| [`1873f1d`](https://github.com/Shuai-S/metapi/commit/1873f1d08482bfb187927f8cebfcc7a289a52425) + [`fd72b20`](https://github.com/Shuai-S/metapi/commit/fd72b20078954f3341b02ec8d47f0c21a1358cb1)：账号分组聚合页 | 浏览器最多 4 并发逐账号拉上游分组，按账号完成流式显示 | 当前已有持久化分组倍率快照，但无全局聚合视图 | 可采纳“总览”概念；改成后端一次查询已持久化快照，显式刷新才访问上游，避免浏览器 N+1 |
| [`5fed304`](https://github.com/Shuai-S/metapi/commit/5fed304a48a25082c03297fa45602d946640edd5) + [`4c9a0f9`](https://github.com/Shuai-S/metapi/commit/4c9a0f97523f4ae8a2548395bff8e71a6a6f2bec)：客户余额快照 | 另建三张表和第二套站点管理员凭证，分页拉 NewAPI/Sub2API 客户并保存快照；后续补 cookie login 的 user ID | 当前无此业务域 | **不采纳实现**；如确有运营需求，单独立项重设计 |
| [`7a9e2f3`](https://github.com/Shuai-S/metapi/commit/7a9e2f30b49740a6adbac0cf927d6d9fb27219e3)：卡密转 Sub2API | 浏览器内解析导出文本、JWT `client_id`、去重并下载 JSON | 当前无此工具，且 2.0 已移除 native OAuth connection | 默认不采纳；仅在确认专用迁移格式后做独立工具 |

### 3.2 Shuai 分支中不能忽略的质量风险

- 客户余额另存一套密码/Access Token，违背账号单一事实源；[schema 证据](https://github.com/Shuai-S/metapi/blob/7a9e2f30b49740a6adbac0cf927d6d9fb27219e3/src/server/db/schema.ts#L547-L603)。它保存完整客户 `rawPayload`/邮箱等 PII，无保留策略；同步最多 200 页后静默截断，[实现](https://github.com/Shuai-S/metapi/blob/7a9e2f30b49740a6adbac0cf927d6d9fb27219e3/src/server/services/customerBalanceService.ts#L495-L613)；快照逐条插入没有完整事务，[实现](https://github.com/Shuai-S/metapi/blob/7a9e2f30b49740a6adbac0cf927d6d9fb27219e3/src/server/services/customerBalanceService.ts#L702-L773)。
- 卡密转换会强制清空 `refresh_token/id_token/organization_id`，[实现](https://github.com/Shuai-S/metapi/blob/7a9e2f30b49740a6adbac0cf927d6d9fb27219e3/src/web/pages/helpers/cardKeyToSub2api.ts#L38-L145)，可能生成不可续期账号；只有 [2 个 helper tests](https://github.com/Shuai-S/metapi/blob/7a9e2f30b49740a6adbac0cf927d6d9fb27219e3/src/web/pages/helpers/cardKeyToSub2api.test.ts#L1-L30)，没有格式契约、文件大小限制或端到端验证。
- `my-main` 的 13 个提交没有完整 Actions test/typecheck/schema parity 证据，因此“提交里有测试文件”不能等价成“分支验证通过”。

## 4. qingdeng888/metapi-qing：新增功能与后续修复

### 4.1 功能清单

| 提交/主题 | 最终行为与“修复”链 | 当前仓库对照 | 判断 |
| --- | --- | --- | --- |
| [`88f2ed7`](https://github.com/qingdeng888/metapi-qing/commit/88f2ed765b8402a9dd25b9a1bcf3444736ff7e49) + [`a637985`](https://github.com/qingdeng888/metapi-qing/commit/a6379852ebdb059078c7e0712c0a0243965bf45e)：客户端伪装 | 给站点增加 Codex/Claude Code 固定请求头 preset；后续修正 Codex 为 `codex_cli_rs/1.0.0` + `Originator`。preset 会作用于代理、登录、余额、签到、发现等所有站点请求，[实现](https://github.com/qingdeng888/metapi-qing/blob/20260711/src/server/services/siteProxy.ts#L367-L400) | 当前已有站点 `customHeaders`，provider header profile 也维护了更新的协议头 | 不采纳该 schema/全局注入实现；若有需求，只做 `customHeaders` 的 UI preset，并限制到真正的代理请求 |
| [`8f3434b`](https://github.com/qingdeng888/metapi-qing/commit/8f3434b880fd3e17ec9e1d7fb9adff7f2a606348) + [`8780b77`](https://github.com/qingdeng888/metapi-qing/commit/8780b7742f5f5e57f48fd68bddf2036098598e1a)：本地 Docker/外网端口 | 新增部署脚本和文档；把端口从 `127.0.0.1:4000` 改为 `4000:4000` | 当前已有 `docker/`、部署指南和发布镜像，且默认 loopback 是安全边界 | 不采纳默认全网卡暴露；LAN 暴露只能做显式 opt-in 文档，不再建立 root Dockerfile/compose 第二事实源 |
| [`4d1913f`](https://github.com/qingdeng888/metapi-qing/commit/4d1913fac01453619b710d90d3fe72a6f614a575)：迁移 journal 修复 | 删除一个重复/不存在条目，但最终 journal 保留 `idx=26` 缺口，[最终文件](https://github.com/qingdeng888/metapi-qing/blob/20260711/drizzle/meta/_journal.json#L184-L203) | 当前迁移链完全不同且有 parity/runtime tests | 不采纳 |
| [`f73ad97`](https://github.com/qingdeng888/metapi-qing/commit/f73ad97561dfc6a34bfe911f2eb35e12db58d58d)：New API user-id headers | 同时兼容多个 session user-id header | 与当前 [`f396014`](https://github.com/iazhan/metapi-plus/commit/f3960147283ebd36f8955b2b2a257674ada9761a) patch-id 相同 | 已覆盖，不采纳 |
| [`adc12f6`](https://github.com/qingdeng888/metapi-qing/commit/adc12f69cf98e94f34cb0a5826d0b9e27ed03752)：checkout v7 | Actions checkout major 更新 | 与当前 `41767a6` patch-id 相同 | 已覆盖，不采纳 |
| [`7ec3409`](https://github.com/qingdeng888/metapi-qing/commit/7ec34095cc77a7aa28dda38a2c8572f6a1ee5676) -> [`3c71acf`](https://github.com/qingdeng888/metapi-qing/commit/3c71acf8a0de78b35369d65ea17b8388cc317fca) -> [`f4b64f5`](https://github.com/qingdeng888/metapi-qing/commit/f4b64f5a1b94d3f32b43cc4b48ebd7b882dca7ae)：新模型默认禁用 | 初版让所有首次发现模型禁用；后续改为首次全启用、之后新模型禁用，再补 Token 级 `available` 一致性 | 当前将 availability 作为发现事实，并用 `siteDisabledModels` 表达禁用；README 明确承诺上游新增模型零配置进入路由 | **不采纳实现**。最终 fork 把新模型写成 `available=false`，但 `available-models` API 只查 `true`，导致 UI 看不到、也无法手动启用；如要该需求，另建“新模型审批/自动纳入策略” |
| [`c526fa6`](https://github.com/qingdeng888/metapi-qing/commit/c526fa6f791f281bc271108fa134feeeeb37c773) 及 `046c1b5/23795ca/e03adfd/8103102/c74a364/dcda118`：下游密钥自动同步 | `autoSyncRoutes` 开启后，每次路由变化把所有 enabled route 复制进 `supportedModels/allowedRouteIds`；后续连续修复迁移缺条目、API 漏字段、SQLite 查询、前端漏 payload、触发点不全和 route/channel 清理 | 当前没有该开关，但下游模型权限已支持 glob/regex，路由有统一 exposed-name 逻辑 | 保留需求，**实现必须重做**为动态 `all routes`/route selector policy；不能复制 fork 的物化快照 |
| [`dcda118`](https://github.com/qingdeng888/metapi-qing/commit/dcda1183f1b86a613ac9aaddac0a208682ae42dd)：stale route/channel 清理 | 删除 route 前显式删除 channels | 当前 FK 已 `ON DELETE CASCADE`，[schema](https://github.com/iazhan/metapi-plus/blob/512517d2ee102bdbb236fb7488f43dcf42a6b793/src/server/db/schema.ts#L314-L340)，且 [回归测试](https://github.com/iazhan/metapi-plus/blob/512517d2ee102bdbb236fb7488f43dcf42a6b793/src/server/services/modelService.test.ts#L149-L224) 已验证 channel 清零 | 不是当前 bug，不采纳；只有确认 legacy DB 缺 FK 时才做事务化兼容修复 |
| [`ada4851`](https://github.com/qingdeng888/metapi-qing/commit/ada48511307ba233e1eb27740ffd8bc8c3943312)：站点/供应商模型别名 | 持久化 `site + sourceModel -> aliasModel`；rebuild 用 alias 替换原候选，channel 保存真实 source model，[核心实现](https://github.com/qingdeng888/metapi-qing/blob/20260711/src/server/services/modelService.ts#L1379-L1469) | 当前 `explicit_group/displayName/sourceModel` 可手工实现全局别名，但缺站点级批量映射 | **P1 调研重做**：概念有净新增价值，代码不可直搬 |

### 4.2 qing 修复链逐项核对

这些提交主要是在修复 qing 自己前一个功能提交的遗漏，不应自动视为当前仓库已有同名 bug：

- [`046c1b5`](https://github.com/qingdeng888/metapi-qing/commit/046c1b5f1e6100d273d8d1123dc2842ab45dcd09)：把 `0028` 写入 Drizzle journal；仍属于旧迁移链，不能移植。
- [`23795ca`](https://github.com/qingdeng888/metapi-qing/commit/23795ca67297bb05667a6c6d55e27546c232dc3)：补 `autoSyncRoutes` API 返回字段，并在创建/更新后触发同步；暴露了前一提交的状态丢失问题。
- [`e03adfd`](https://github.com/qingdeng888/metapi-qing/commit/e03adfda28f99c4edd20f2bd5b0b96c9a52e1442)：把 SQLite 布尔查询从 `true` 改为 `1`，并加入 console 调试日志；没有解决并发、权限扩张或审计问题。
- [`8103102`](https://github.com/qingdeng888/metapi-qing/commit/810310299b3ec9316961bb4035586e84854371c7)：补前端保存时漏发的 `autoSyncRoutes` 字段。
- [`c74a364`](https://github.com/qingdeng888/metapi-qing/commit/c74a364acddae06a71a975bc3c0c3a8c9d4dd980) 与 [`dcda118`](https://github.com/qingdeng888/metapi-qing/commit/dcda1183f1b86a613ac9aaddac0a208682ae42dd)：补路由重建后的同步触发，并显式删除 stale route channels；当前仓库的 FK cascade/回归测试已覆盖后者。
- [`f4b64f5`](https://github.com/qingdeng888/metapi-qing/commit/f4b64f5a1b94d3f32b43cc4b48ebd7b882dca7ae)：把 Token availability 从硬编码 `true` 改为跟随默认禁用策略；这仍带来“新模型不可见、无法手动启用”的最终缺陷。
- [`3c71acf`](https://github.com/qingdeng888/metapi-qing/commit/3c71acf8a0de78b35369d65ea17b8388cc317fca) 修正首次添加渠道全禁用的回归，并新增 root Docker 配置；root Dockerfile/compose 与当前 `docker/` 体系重复。`fc96cec`、`2a81f35`、`a2bcd87` 只新增修复/部署说明文档，没有替代代码验证。

### 4.3 qing 最终分支仍存在的关键风险

- `autoSyncRoutes` 会覆盖人工 `supportedModels/allowedRouteIds`，任何 enabled route 都可能扩大下游 Key 权限；实现读取 `modelPattern` 而非 exposed `displayName`，也不确认 route 是否存在有效通道。
- 同步由多个入口 fire-and-forget 触发，没有 singleflight、事务、版本或顺序保证；全局扫描后逐 Key N+1 写，失败只写 console，调用方已经返回成功。[最终服务](https://github.com/qingdeng888/metapi-qing/blob/20260711/src/server/services/downstreamKeySyncService.ts#L9-L74) 与 [触发点](https://github.com/qingdeng888/metapi-qing/blob/20260711/src/server/services/routeRefreshWorkflow.ts#L8-L36) 均无对应测试。
- `autoSyncRoutes`、`clientSpoofing`、`siteModelAliases` 没有完整进入 backup/export/import 和 databaseMigration 显式字段/表清单，迁移或恢复会静默丢配置。
- 站点别名是 replacement，不是 additive：有 alias 时原模型候选消失，rebuild 可能删除原精确 route，连带影响人工通道、策略和下游权限；source model 匹配还没有统一大小写，手输大小写差异会静默失效。别名功能没有测试，且 site route 直接调用 `modelService`，不符合当前共享 route workflow 边界。
- 固定客户端伪装头会过期，Claude beta header 已落后；“绕过客户端限制”还可能触及上游服务条款，不能作为默认产品能力。

## 5. 当前仓库对照结论

| 能力 | 当前状态 | 移植结论 |
| --- | --- | --- |
| 新站点检测使用未保存的代理设置 | **缺失** | 从 Shuai 提取行为，按当前 `siteProxy`/adapter capability 重写 |
| 账号列表搜索 | **缺失**；已有“全选可见项” | 只补搜索和“批量仅命中过滤结果”测试 |
| 站点/账号备注 | **缺失** | 可做，但属于 schema/API/backup/UI 完整切片 |
| Sub2API 密码登录、refresh、倍率 | **已有且更完整** | 不移植 |
| 普通编辑 `platformUserId` | **部分缺失**；create/rebind 已有 | typed API 小功能，不复制 `extraConfig` |
| 账号分组总览 | **有持久化数据，无全局视图** | 基于 snapshot 做后端查询，不做浏览器 N+1 |
| Password 连接转换 | **同站点同用户名可通过 login upsert 隐式转换，缺 account-ID 定向编辑** | 独立服务流程，条件采纳 |
| 客户余额运营域 | **缺失** | fork 实现不采纳，产品确认后另立规格 |
| 客户端请求头 preset | **可用 customHeaders 手工表达** | 最多做 UI preset，不新增全局注入 schema |
| 新模型审批/自动纳入策略 | **当前自动纳入** | fork 补丁有不可见模型缺陷；若改变产品策略需独立设计 |
| 下游 Key 跟随全部路由 | **可用 API glob `*` 表达全部模型，但 UI 无显式模式** | 用动态 policy/明确“全部当前及未来模型”，不复制 JSON 快照 |
| 站点级模型别名 | **仅有 route-level 手工别名** | 有价值，复用现有 route/sourceModel 深模块重做 |
| stale route 清理 | **已有 FK cascade 和测试** | 不移植 |
| Docker/Actions | **当前更完整** | 不移植；保持默认 loopback |

## 6. 按优先级排序的吸收清单

### P0：无

没有发现一个同时满足“当前仍存在、影响严重、fork 最终实现完整且有验证证据”的 Critical 修复。不要为了填 P0 把 fork 自己引入后再修复的问题算作当前缺陷。

### P1：建议近期实施

1. **代理感知的站点检测（Shuai `2023b857`）**

   把 `proxyUrl/useSystemProxy` 作为受校验的 detection context 传入 Web detect API、创建时的自动 detect、`detectPlatform()` 和 title-hint；复用当前显式 proxy dispatcher，不记录含凭据的代理 URL。补 direct/HTTP/SOCKS/system proxy、非法协议、超时和“不影响已保存站点代理”的测试。不可 cherry-pick 整提交。

2. **账号列表关键词搜索（Shuai `2023b857`）**

   搜索账号名、站点、状态和 ID；桌面与移动端复用 `ResponsiveFilterPanel`。现有 `visibleAccounts` 和批量选择已足够，只需保证“全选/批量”作用于过滤结果并补回归测试。不要带入 SiteBadgeLink 直接外链行为。

3. **站点级 additive 模型别名设计（qing `ada4851`）**

   先确定语义：原模型保留，alias 额外暴露；冲突、大小写、循环、同 alias 多站点、路由禁用、成本归属和下游授权都要明确。实现应复用 `explicit_group/displayName/sourceModel` 的路由深模块和 shared workflow，不能让 sites route 直接拥有重建逻辑。需要重新生成当前编号的三方言 schema/migration，纳入 backup/import、factory reset、schema parity 和端到端代理测试。

### P2：有价值，但先确认产品需求

1. **下游 Key 的“全部当前及未来路由”权限预设**

   吸收 qing `autoSyncRoutes` 的用户需求，不吸收实现。当前契约已能用 `supportedModels: ['*']`、`allowedRouteIds: []` 表达全部当前及未来模型；TokenRouter 在 route ID 为空时不做 route-ID 过滤。优先增加一个明确 UI 策略预设映射到该现有契约，不新增 schema 字段、后台复制或异步同步任务。UI 必须确认权限扩大并能恢复到精确模型/路由群组模式；补 `*` 对 `/v1/models`、displayName、explicit group 和最终路由选择的端到端测试。

2. **站点/账号备注**

   从当前 schema 重新生成迁移和 artifacts；限制长度，支持 `null` 清空，接入搜索、移动端、管理 API、backup/export/import、跨方言 bootstrap/upgrade，并补契约/恢复测试。

3. **普通编辑 `platformUserId`**

   update contract 增加 `platformUserId: number | null`，服务端只 merge 该字段；更新后按需要触发 session 验证/缓存失效。不得让前端回传完整 `extraConfig`。

4. **分组倍率总览**

   用现有 `accountGroupRates` 做一次后端查询；“刷新”显式调用现有 rate sync/scheduler 能力并给出逐账号错误。不要复制 fork 的浏览器四并发 N+1。

5. **已有连接转换为 Password 登录**

   仅补现有 login upsert 覆盖不到的 account-ID 定向 UX。建议 `POST /api/accounts/:id/rebind-password`：复用账号级代理、timeout/signal、`accountLoginSessionService`、`syncAccountPlatformData` 和现有加密密码存储；优先采用 `loginResult.platformUserId`，以旧 account/session snapshot 做 CAS，并发 disable/rebind 时返回冲突。Sub2API 必须保留新登录返回的 refresh/expiry；转换失败不得清空旧凭据或完整 Token/倍率快照。

6. **新模型审批策略或请求头 preset**

   两者都应是显式 opt-in。模型策略要把“已发现”与“允许进路由”分离；请求头 preset 只生成/填充现有 `customHeaders`，且限定代理 surface，不伪造所有管理请求。

### 不采纳

- 不整分支 merge，也不直接 cherry-pick 旧迁移、schema snapshot、Dockerfile 或大页面文件。
- 不采纳 qing 的默认公网端口、journal 缺口修补、全局客户端伪装、当前形式的新模型默认禁用、物化 `autoSyncRoutes`、显式 stale-channel 删除。
- 不采纳 Shuai 的客户余额实现；第二套凭据、PII/raw payload、非事务快照和静默截断风险过高。
- 不采纳当前卡密转换实现；它与 2.0 OAuth retirement 边界冲突且会丢失续期凭据。只有用户提供正式输入/输出 fixture 和迁移场景后再单独评估。
- 不重复吸收已在当前 HEAD 的 New API user-id headers、checkout v7、Sub2API managed auth、Token 分组倍率和 Docker 发布能力。

## 7. 依赖、安全、迁移与测试风险

### 依赖和架构

- 代理检测无需新增依赖，复用现有 `undici` dispatcher、`siteProxy` 和 platform detection context；检测逻辑仍归 platform capability，不在 route adapter 内实现网络策略。
- 站点别名必须复用 route/sourceModel 事实源，避免再造一套与 `displayName/modelMapping` 竞争的路由系统。
- 动态下游权限必须消费统一 route surface；不能让同步任务、下游 key JSON 和 token route 各自成为事实源。

### 安全

- 代理 URL 可能含用户名/密码：API 错误、日志、事件和测试快照都必须脱敏；协议只接受当前允许的 HTTP(S)/SOCKS，避免把任意 dispatcher 配置暴露给 renderer。
- “全部路由”会自动扩大下游权限，必须是显式选择、可审计、可预览、可立即撤销。
- 客户端伪装可能违反上游限制或服务条款，且固定 headers 会失效；不应默认开启。
- 客户余额/卡密工具处理密码、Token 和 PII；若未来立项，必须有字段最小化、加密、访问控制、保留/清理、文件大小与格式边界，日志使用 `[REDACTED]`。

### 迁移和备份

- fork 的 `0027/0028/0029` 与当前 migration history 冲突，不能复制；任何新表/列都要同步 Drizzle schema、SQLite migration、MySQL/Postgres generated artifacts 和 schema contract。qing 的 `dev` 到 `20260712` 只有 SQLite 的 `client_spoofing/auto_sync_routes` 变更，直到 `20260711` 才随 alias 生成物顺带补齐跨方言 artifacts，不能把早期分支当作可部署终态。
- 所有持久化新字段必须进入 backup/export/import、databaseMigration、factory reset、runtime bootstrap 和跨方言 parity/upgrade 测试；fork 在这些位置有多处遗漏。
- 当前已移除 native OAuth connection；所有从 fork 抽出的 modelService 补丁都要先删除已失效 OAuth 分支假设。

### 测试

- 两个定制分支都缺完整 CI 证据，不能继承其“已验证”结论。
- 代理检测：route contract、显式/系统代理、每类 adapter/title hint、超时与凭据脱敏。
- 账号搜索：桌面/移动端、segment、空结果、全选可见项、批量 action IDs。
- 别名：additive 语义、冲突/cycle、刷新重建、真实 upstream model、计费与路由决策、下游 `/v1/models`、backup round-trip、SQLite/MySQL/Postgres parity。
- 下游 `*` 权限预设：空权限仍 deny-all、`*` 的模型列表和实际路由、禁用/无有效通道路由、displayName/explicit group、权限扩大确认、审计日志和撤销。

## 8. 建议实施顺序

1. 先做无 schema 的两个独立小切片：代理感知检测；账号列表搜索。各自定向测试后运行 `repo:drift-check`（代理检测涉及平台边界）。
2. 用短规格确认三项产品语义：站点别名是 additive 还是 replacement；下游“全部路由”是否包含未来路由；新模型默认是否自动纳入。
3. 实施 typed `platformUserId` 编辑；若确认需要，再把 remark 作为一个完整 schema/API/backup/UI 切片。
4. 设计并实现 additive 站点别名，先建立路由领域契约和测试，再接 Sites UI；不要从 fork 搬迁移或 `modelService` 大段补丁。
5. 最后实现动态下游权限模式；它会改变权限边界，需独立审查和更深验证。
6. 分组总览、Password 转换、客户余额、卡密转换和请求头 preset 保持候选，只有明确用户场景与验收标准后再立项。

## 9. 最终建议

可以立即吸收的是两个小而明确的行为：**新站点检测尊重尚未保存的代理配置**、**账号列表可搜索且批量操作只作用于过滤结果**。最有战略价值但必须重做的是 **站点级 additive 模型别名** 和 **下游 Key 动态跟随全部路由**。

其余大部分提交不是当前缺陷：有些已被当前仓库以更完整的方式实现，有些只是修复 fork 自己刚引入的问题，还有些会破坏当前 OAuth retirement、单一事实源、权限和跨方言迁移边界。因此建议按上述独立切片吸收，不合并任一 fork 分支。
