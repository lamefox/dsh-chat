# 市场索引与分发

| 用途 | URL |
|---|---|
| 自建索引源（npm 包内，推荐） | `https://cdn.jsdelivr.net/npm/@lamefox/dsh-chat/market/index.json` |
| 自建索引源（GitHub 分支，可能有 CDN 缓存延迟） | `https://cdn.jsdelivr.net/gh/lamefox/dsh-chat@main/market/index.json` |
| 直接安装（不走市场） | `dsh plugin --profile web add @lamefox/dsh-chat` |

## 在 DSH 里加源

插件 → **Discover** → **Index sources** → 添加上面的 raw 或 jsDelivr URL。
添加后即可搜索 `dsh-chat` 并一键安装（索引里的安装目标是固定 commit 的 git 源）。

## 格式

`index.json` 是 [format-1 索引](https://www.npmjs.com/package/@deepseek-ai/dsh-plugin-market-index)：
`{ format: 1, title, metadata, plugins: [{ name, versions: [{ version, publishTimestamp, source, engines }] }] }`。

发版流程：改 `package.json` 版本 → 提交 → 把 `market/index.json` 里的 `version` / `publishTimestamp` / `source.commit` 更新为新 sha → 提交。

## 社区市场

`market/awesome-submission.yml` 是 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的投稿文件内容，
提 PR 时放到 `data/plugins/lamefox__dsh-chat.yml`（一个文件即全部投稿，README 由脚本生成）。
