# dsh-chat

DSH 插件：在已运行的 DSH Web 服务器上**另开一个独立聊天窗口**（`/chat`），并把它做成 chat-demo 的形态——浏览器端只做渲染，联网搜索、链接阅读、内容安全、会话标题这些「服务端能力」由插件在宿主侧注入。

它**不走** DSH 的 agent 会话（不加载工具、技能、子沙箱、MCP），而是直接对着 `api.deepseek.com/anthropic/v1` 的 Messages API 说话；API Key 只存在于宿主进程，页面永远看不到。

## 安装

### 从市场安装

在 DSH 的 **插件 → Discover → Index sources** 添加：

```
https://cdn.jsdelivr.net/npm/@lamefox/dsh-chat/market/index.json
```

然后搜索 `@lamefox/dsh-chat` 一键安装；或者直接：

```sh
dsh plugin --profile web add @lamefox/dsh-chat
```

索引随 npm 包一起发布（包内 `market/index.json`，包不可变、无需 CDN 刷新），所以索引里的版本永远等于当前发布版本。国内镜像尚未同步时可临时指定官方源：
`dsh plugin --profile web add @lamefox/dsh-chat --config.registry=https://registry.npmjs.org`


### 从他人分享的压缩包安装

```sh
# 收到 lamefox-dsh-chat-0.5.1.tgz 后
dsh plugin --profile web add ./lamefox-dsh-chat-0.5.1.tgz
dsh web                      # 重启后生效
```

启动日志会打印 `[dsh-chat] window: http://127.0.0.1:<端口>/chat`。

### 从源码目录安装（本机开发）

```sh
dsh plugin --profile web add link:/home/lamefox/dsh-chat   # 软链，改代码即时生效
```

### 上架插件市场

DSH 的市场不是"提交审核"，而是**索引源 + 安装目标**：宿主读取一个 format-1 JSON 索引，索引里每条指向 npm 包或 git 仓库。

仓库里已带一份可直接使用的索引：[`market/index.json`](market/index.json)。

1. 先把包发到 npm（或推到公开 git）：

   ```sh
   # 去掉 package.json 的 "private": true，并让 name 与 cordis.patch.yml 里的 name 一致
   npm publish --access public   # 已配置 publishConfig.access
   ```

2. 更新 `market/index.json` 里的 `name` / `version` / `publishTimestamp`（Unix 秒）/ `engines.dsh`。

3. 校验索引（用 DSH 自带的校验器，不需要装额外依赖）：

   ```sh
   node -e "const {parseMarketIndex}=require('@deepseek-ai/dsh-plugin-market-index'); ..."
   ```

4. 托管这个 JSON（GitHub Pages / jsDelivr / 任意静态站），然后在 DSH 里
   **插件 → Discover → Index sources** 添加该 URL。

5. 想进社区市场：给 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提 PR 加一条，
   站点与 `dshmarket` 会自动收录（通常一天内）。**不要**往 dshmarket 仓库提插件条目。

### 自己打包分发

```sh
npm run pack     # 生成 lamefox-dsh-chat-0.5.1.tgz
npm run dist     # 额外生成 sha256 校验文件
```

包内只含 `lib/`、`cordis.patch.yml`、`README.md`、`package.json`；`test/` 与本地数据库不会进入包。

**改名或发 npm 时注意**：`package.json` 的 `name` 必须与 `cordis.patch.yml` 里 `name:` 完全一致（当前都是 `@lamefox/dsh-chat`），否则宿主找不到插件；发公开源要先删掉 `private: true`，建议加 scope（如 `@you/dsh-chat`）并同步改 patch。


```sh
# 从本机目录安装到 web profile
dsh plugin --profile web add link:/home/lamefox/dsh-chat

# 重启 web（或在 HMR 生效后刷新页面）
dsh web
```

启动后会在默认浏览器里打开 `http://127.0.0.1:3080/chat`（端口以你的 `dsh web` 为准）。
同一 profile 侧栏的 DSH 主界面不受影响，两者共用同一个 web 服务器与端口。

卸载：

```sh
dsh plugin --profile web remove dsh-chat
```

## 配置

在 profile 的 `cordis.patch.yml` 覆盖，或用 `--patch` 临时覆盖：

```yaml
- id: dsh-chat
  config:
    path: /chat                 # 挂载路径
    model: deepseek-flash       # 默认模型（页面可用 state 里的值覆盖）
    baseUrl: https://api.deepseek.com/anthropic/v1
    auth: auto                  # auto | apiKey | account（auto：先试账号登录，再回落 API Key）
    apiKeyEnv: DEEPSEEK_API_KEY # Key 从这里读，其次 credentials 服务，最后 apiKey
    apiKey: null                # 不建议：明文写在配置里
    safetyCheck: high           # high | off（部署级，页面不可改）
    search: true                # 页面「智能搜索」的上限
    readUrl: true               # 页面「智能搜索」的上限
    title: true                 # 注入 title.enabled
    thinking: true              # false 则锁定「深度思考」为不可用（默认由页面决定，见下）
    openBrowser: once           # once | always | never
    allowRemote: false          # true 才允许非 loopback 客户端访问
```

### 认证方式

设置 → 模型 页面里有两套凭据，dsh-chat 走 `auth` 配置决定用哪套：

| `auth` | 行为 |
|---|---|
| `auto`（默认） | 先试 **DeepSeek 账号登录**（`deepseekAccount.resolveToken`，请求头 `x-dsh-auth-token`）；拿不到再回落 API Key |
| `apiKey` | 只用 API Key（`x-api-key`），忽略账号登录 |
| `account` | 只用账号登录；未登录时直接 503 并提示去设置里登录 |

账号 token 只对配置的推理源生效（默认 `https://api.deepseek.com`）；自定义 `baseUrl` 会自动跳过账号、回落 API Key。

Key 的解析顺序：`apiKey` 配置 → 环境变量 `apiKeyEnv` → `ctx.credentials.resolve(apiKeyEnv)`。都不存在时页面顶部显示「未配置 API Key」，代理返回 503 并说明怎么配。

## 已实现（对照 chat-demo）

| 能力 | 状态 |
|---|---|
| 独立窗口 / 独立页面 | ✅ `/chat`，启动时自动新开窗口 |
| 页面开关：深度思考（默认关）/ 智能搜索（默认开） | ✅ 输入框 pill，按会话记忆，配置为上限 |
| 流式回答、停止生成 | ✅ SSE 直通 |
| 深度思考（可折叠、计时） | ✅ |
| 联网搜索 / 深度搜索 / 图搜卡片 | ✅ `server_tool_use` + `web_search_tool_result` |
| 阅读链接卡片 | ✅ `web_fetch_tool_result` |
| 引用角标 + 来源列表 | ✅ `citations_delta` |
| 内容安全（`safety_check.high`） | ✅ 由代理注入 |
| 会话标题（`title.enabled`） | ✅ 取 `message_delta.title` |
| 用户元信息标记 | ✅ `role: latest_reminder` 快照 |
| 附件上传（图片 / PDF / Office / 文本） | ✅ Files API，按 `purpose` 分流 |
| 继续生成（`max_tokens` 之后） | ✅ 以 assistant 前缀续写 |
| 朗读回答 | ✅ 浏览器 `speechSynthesis` |
| 多会话 / 自动标题 / 删除 / 导出 / 导入 | ✅ SQLite + JSON |
| 工作区归纳对话 | ✅ 侧栏选择器 + 移动菜单（删除工作区保留会话） |
| 深浅主题 | ✅ 仅中文文案，主题三态可切 |
| Markdown / 代码块 | ✅ 轻量渲染器 |
| KaTeX 公式 / Mermaid | ❌ 未实现 |
| 编辑已发送消息 / 消息分支 | ❌ 未实现（需会话树） |
| 语音输入 | ❌ 未实现（可另启 `@deepseek-ai/dsh-experimental-voice-input-bundle`） |

## 界面

按 DeepSeek 对话页的设计语言重做（`0.2.0` / `0.2.1`）：

- 左侧 260px 侧栏，顶栏只有标题与模型徽标，正文单列 **760px 居中**
- 用户消息右对齐浅蓝气泡（18/18/6/18 圆角），hover 出现「复制 / 编辑」图标
- 助手消息无气泡通栏；**搜索摘要 chip**（搜索到 N 个网页 + 站点图标堆叠）在正文上方
- **右侧「搜索结果」面板**（420px）：站点图标、站点名、日期、序号徽标、标题两行+摘要三行，点击直达原页；窗口 <1180px 时转为浮层
- 引用角标按全对话来源注册表编号，与面板序号一致
- 每条回答底部：AI 生成提示（斜体）→「N 个网页」来源胶囊 → 图标操作栏（复制 / 重新生成 / 朗读 / 分享）
- 输入区 24px 圆角卡片 + 两个 pill（深度思考默认关、智能搜索默认开）+ 圆形发送/停止
- 右下角悬浮「回到底部」按钮、顶部免责声明、浅色/深色主题、≤860px 侧栏转浮层

## 内嵌到 DSH 界面（0.6.0）

插件带一个浏览器端入口（`lib/client.js`，无构建、无 npm 依赖），把对话嵌进 DSH 自己的界面：

- 左侧栏页脚多一个「对话」按钮（`sidebar.footer.action`，list 槽）；
- 点它会在右侧栏开一个 `dsh-chat` 标签页（`sidebarRightTabs` + `sidebar.right.pane.tab`），
  面板内容是一个 iframe，指向 `{origin}/chat?embed=1`；
- `?embed=1` 时页面隐藏自己的顶栏、把 260px 侧栏改成抽屉，正文铺满面板宽度。

对话逻辑、SSE、SQLite 全在 iframe 里那份页面中，**与独立 `/chat` 页面是同一份代码**，
所以两边数据天然一致（都走服务端 `chat.db`）。

实现上有两处必须照宿主规矩来，否则整页会停在启动失败卡片：

1. `apply` 里任何注册抛错都会被宿主记成 `1 entry did not activate`，界面直接白屏。
   因此每一步都包在 `step(name, run)` 里，失败只打印一条 console 错误，不影响宿主。
2. `sidebar.footer.action` 由 `@deepseek-ai/dsh-client-ui-sidebar` 的工厂**声明**，
   而它和本插件可能落在不同的启动批次；注册太早会抛
   `slot "sidebar.footer.action" is not declared`。这里按 60/200/600/1500/3000ms 退避重试，
   最多约 5 秒；仍不出现就安静跳过（独立页面不受影响）。

想关掉内嵌：删掉 `package.json` 里的 `dsh.client` 字段（或 `exports["./client"]`）后重启 web，
`/chat` 仍然可以单独打开。

## 持久化（0.3.0，SQLite）

默认把会话写进**本机 SQLite 数据库**（不是浏览器）：

```
$DSH_HOME/dsh-chat/chat.db
```

- Node 内置 `node:sqlite`，无原生依赖；WAL + `busy_timeout`，单写者（宿主进程）。
- 表：`sessions`、`messages`（`UNIQUE(session_id, seq)`，id upsert）、`messages_fts`（FTS5 **trigram**，中文可搜）。
- 写入时机：用户消息**发送前立即写**；回答在流结束时写一次（不是每个 token）；标题变化时 PATCH。
- 删除/重新生成会同步删除对应消息行（`POST .../messages/delete`），不会在刷新后复现。
- 列表只查元数据，正文**按会话懒加载**（`GET /sessions/:id`），历史会话再多也不拖慢首屏。
- 主题是 UI 偏好，仍存 `localStorage`；对话数据不再写 `localStorage`。

## 工作区（0.4.0）

侧栏顶部的工作区选择器把对话分组归纳。一个会话最多属于一个工作区，工作区只是"文件夹"，不拥有会话。

- `全部对话 / 未分组 / 各自定义工作区`，带实时计数
- `＋` 新建、`✎` 重命名、`🗑` 删除；**删除工作区不会删对话**，其会话回到「未分组」
- 会话项 hover 的 `→` 打开移动菜单，把会话搬到别的工作区
- 在某个工作区下新建对话时，新会话直接归入该工作区
- 筛选状态记在浏览器（`dsh-chat:workspace-filter`）

### 清空全部

侧栏底部 `清空` → 二次确认 → 删除**全部对话**（消息与搜索索引一并清除），工作区配置保留。

### 路由

```
GET    /chat/api/sessions[?workspaceId=all|none|<id>]  列表（过滤）
DELETE /chat/api/sessions                  清空全部对话
GET    /chat/api/workspaces                工作区列表（含会话数）
POST   /chat/api/workspaces                新建 {name}
PATCH  /chat/api/workspaces/:id            重命名 {name}
DELETE /chat/api/workspaces/:id            删除（会话回到未分组）
PATCH  /chat/api/sessions/:id              {title?} / {workspaceId?}
POST   /chat/api/sessions                  新建
GET    /chat/api/sessions/:id              读一个会话的全部消息
PATCH  /chat/api/sessions/:id              改标题
DELETE /chat/api/sessions/:id              删除
POST   /chat/api/sessions/:id/messages     写入/更新一条消息
POST   /chat/api/sessions/:id/messages/delete  回退若干条（重新生成）
GET    /chat/api/search?q=&limit=          全文检索
POST   /chat/api/import                    导入浏览器数据
```

全部走同一个页面 token 校验 + loopback 限制。

### 降级与迁移

- **降级**：宿主若还是旧版本插件（没有上面的路由），页面探测 `GET /sessions` 失败后自动回到 `localStorage` 模式，不白屏。
- **迁移**：首次连上数据库且库里为空、浏览器里已有对话时，会询问一次是否导入（`POST /import`），导入成功后清除浏览器副本。

### 配置

```yaml
- id: dsh-chat
  config:
    storage: sqlite            # sqlite | none（none = 退回纯浏览器）
    dbPath: /custom/chat.db    # 可选，默认 $DSH_HOME/dsh-chat/chat.db
```

### 注意

- `node:sqlite` 在 Node 22.5+ 提供，API 仍标 experimental；`engines.node` 已限定 `^22.19 || >=24`。
- 备份不要直接 `cp chat.db`（WAL 未 checkpoint），用 `sqlite3 chat.db "VACUUM INTO 'backup.db'"`，或使用导出 JSON。
- 数据从「只在本浏览器」变成「本机 `$DSH_HOME` 明文库」，同机其他程序可读。

## 页面开关的语义

输入框左下角两个 pill（对照 DeepSeek 网页端）：

- **深度思考**：控制请求里的 `thinking.type`，**默认关闭**，点一下才开（开一次会在本轮多一轮推理，搜索也会变成边想边搜）。
- **智能搜索**：控制请求里的 `tools`（`deepseek_web_search` + `deepseek_read_url`），**默认开启**。关掉后整轮不联网。

两个开关存 `localStorage`（键 `dsh-chat:prefs:v2`），只影响当前浏览器；插件配置里的 `thinking` / `search` / `readUrl` / `safetyCheck` 是**上限**——配置写成 `false` 时对应 pill 变灰不可点，页面不能把部署关掉的能力打开（代理按白名单取交集）。

## 实现要点

- `lib/index.js`：宿主插件。注册 `{path}`（页面）、`{path}/app.js`、`{path}/style.css`、`{path}/api/{state,messages,files,files/:id}`；启动后轮询 `webServer.getOrigin()` 再开窗口。
- `lib/app.js`：浏览器端。自己解析 SSE、维护块模型（thinking / text+citations / server_tool_use / 工具结果）、拼请求。
- **每个进程一个页面 token**：页面内嵌随机 token，所有 `/api/*` 必须带 `x-dsh-chat-token`；token 不对返回 401。
- **只服务 loopback**：非本机来源直接 403（`allowRemote: true` 才能放开）——因为页面本身会带着 token 下发，能打开页面就能调用 API。
- 代理对上游非 2xx 保留状态码与错误体；客户端断开时 abort 上游请求。

## 质量与测试

```sh
npm test          # 27 个单测 + 24 项代理端到端检查
npm run test:unit # 只跑 lib/text.js 的纯函数测试
node test/smoke.mjs
```

- `lib/text.js` 是转义 / markdown-lite / 回答分段合并的规范实现，纯函数、无 DOM，可直接 `node --test`。
- `lib/app.js` 内联同一份实现（页面自包含，宿主不重启也能渲染），单测里有一项**字节级漂移守卫**：两份副本一旦不一致即失败。
- `test/client.test.mjs` 在 `node:vm` 里跑客户端 bundle：验证入口形状、三个槽位注册点、
  缺服务时安静退场、**任一注册抛错不冒泡**、以及「槽位未声明→退避重试」这条回归。
- `test/smoke.mjs` 用假上游验证代理：页面/token、静态资源、401/405、`tools` 收窄、`safety_check`/`title` 注入、SSE 透传、上游错误透传、state 不泄露 key。

流式渲染只重绘当前那一条回答（80 条消息、1840 个 DOM 节点的实测）：

| | 每帧耗时 |
|---|---|
| 全量 `render()` | 37.3 ms |
| 只重绘流式中回答 | 0.1 ms |

```sh
node test/smoke.mjs
```

不依赖 DSH 启动：在普通 http 服务器上挂载插件路由，用假上游检查 6 件事——页面与 token 注入、静态资源、无 token 401、注入的 `tools`/`safety_check`/`title`、SSE 原样透传、上游 429 原样透传、state 不泄露 Key。

本次已在真实 DSH 启动（临时 `DSH_HOME` + 从 web 模板初始化的 profile）下验证：页面 200、资源 200、`/api/state` 返回 `hasKey: true`、`/api/messages` 完整流过 SSE、上游收到 `tools`+`safety_check`+`title`、启动日志打印窗口地址。

## 与原版页面的差异

| 原版元素 | 本实现 |
|---|---|
| 点赞 / 点踩 | 未做（没有反馈后端，不想做假交互） |
| 消息内分支切换 | 未做（需会话树；当前用「重新生成」覆盖该轮） |
| 检索结果卡片里的站点 favicon | 有 `site_icon` 时用真图标，否则用站点首字母圆形占位 |
| Markdown 表格 / KaTeX / Mermaid | 未做（轻量渲染器） |

## 已知限制

1. 不经过 DSH agent：没有工具调用、技能、沙箱与工作区上下文——这正是它与「DSH 主界面」的分工。
2. 会话存在本机 SQLite（`$DSH_HOME/dsh-chat/chat.db`），不写 DSH 的 session 日志；换机器需自行导出/导入。
3. 附件 `file_id` 由服务端保管，本地只存引用；删除服务端文件后历史里的引用会失效。
4. `openBrowser: once` 与 DSH 自己的「自动打开主界面」是两件事，用 `dsh web --no-open` 只关掉 DSH 那个。
