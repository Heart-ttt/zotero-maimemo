# 交接：当前进度与待办

2026-10-08 更新。

## 一句话

在 Zotero 阅读器里划词，把词加进你在设置里选定的墨墨云词本和学习计划。只同步单词，不做例句和出处。范围和已知限制见 [SCOPE.md](SCOPE.md)。

## 现状

0.1.0 可安装，一次提交（`565432b`）。`npm test` 50 个用例，49 过 1 跳过；`npm run build` 出 xpi。

2026-10-08 用真实 Token 验过两条路：列云词本（只读）和新建云词本（写）。新建那条一次就暴露了假对象测不出的问题 —— 空 `content` 被 400 拒掉，已改为用章节标题占位。

2026-10-09 又验了加入学习计划这一步：拿计划里已有的词跑插件自己的网关，`added_count` 回 0、走核对分支、算成功，学习记录没有任何变化。

**只剩追加词到云词本这一步没对真实接口跑过。**

同日还确认了两件事：开放 API 拿不到词典自带的释义（三个内容接口只回用户自建的，全是空数组）；词库对变形词的收录没规律，分词形容词基本都有独立词条。细节见 [SCOPE.md](SCOPE.md) 的接口事实。

验证时在账号里留了两个词本，名字以 `[可删]` 开头，确认完可以删。

## 已完成

- 开放 API 实测 → [2026-09-21-api-probe.md](2026-09-21-api-probe.md)
- 前置验证脚本 `scripts/verify-maimemo.sh`，2026-10-04 跑过 auth、coverage、study 三项，结果在 `out/`（gitignore，不在版本库里）
- 词形还原从空壳换成规则实现，58 个真实用例通过

## 下一步

1. 装进 Zotero 走一遍端到端：划词、加入、看词本和学习计划有没有真的进去
2. 用词库仲裁收口词形还原的歧义，见 [SCOPE.md](SCOPE.md) 的下一步
3. `advance: true` 写死，做成设置项
4. 验证最后一步写入：追加词到云词本

## 验证脚本的已知问题

审过但没修，跑之前心里有数：

- `out/raw/` 的编号每次从 001 重来，重跑会覆盖上一次的原始响应；`results.tsv` 和 `summary.md` 每次被截断。2026-10-04 那轮 coverage 的汇总就是这么丢的，只剩 `coverage.csv`
- curl 没设超时，连接挂住会一直等
- `--word` 不做 URL 编码，词里带 `&` 会静默查成别的词
- `.env` 解析不认 `export` 前缀，也不剥行尾空格和 CR
- DELETE 若返回 204 会被判成失败

## 必须记住的约束

- 路径是 `https://open.maimemo.com/open` + `/api/v1/memo/...`。2026-09-21 实测用的不带 `memo` 的路径也能通，但官方文档里没有，不要再用
- **`applications.zotero.update_url` 不能从 manifest 里删掉**，Zotero 10 缺了它拒绝安装，
  却报「可能无法与该版本的 Zotero 兼容」，会把人引到版本号上白查一轮
- 新建云词本的 `content` 不能为空，空串返回 400 `notepad_invalid_content`。官方文档没写这条
- `query_study_records` 的 `tags` 过滤传 `WELL_FAMILIAR` 会返回 400，传 `STICKING` 正常。返回的记录里 `tags` 是数组不是文档写的字符串
- 频控 10 秒 20 次、60 秒 40 次、5 小时 2000 次。**每天 600 条的创建配额对本项目不适用**，那个只计例句、助记、释义
- 墨墨没有 refresh token。token 是 43 字符不透明串，有效期读不出来，失效的唯一信号是 401 + `common_unauthorized`
- token 用 App 内「我的 → 更多设置 → 实验功能 → 开放 API」那个。写进根目录 `.env` 的 `MAIMEMO_TOKEN=`，已在 `.gitignore` 里。不要明文贴进对话
- 官方 OpenAPI 文档是 SPA，抓不到正文，要下载 yaml 看

## 未决

- Zotero 8 / 9 / 10 里 `renderTextSelectionPopup` 这套 API 还在不在。`manifest.json` 声称支持到 `10.*`，只在 master 分支上查证过
- `manifest.json` 的 `update_url` 指向一个几乎肯定不存在的 zotero.org 地址，更新检查会一直失败
