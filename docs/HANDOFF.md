# 交接：当前进度与待办

2026-10-15 更新。

## 一句话

在 Zotero 阅读器里双击划词，把词加进你在设置里选定的墨墨云词本和学习计划。只同步单词，不做例句和出处。范围和已知限制见 [SCOPE.md](SCOPE.md)，模块结构见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 现状

- 1.0.0 已发布：GitHub Release `v1.0.0` 附带 `zotero-maimemo-1.0.0.xpi`。插件 ID 是 `zotero-maimemo@heart-ttt.github.io`，更新地址指向仓库 main 上的 `update.json`。0.x 版本用的是旧 ID `wordsync-maimemo@lokan.local`，Zotero 不会把它们当成同一个插件升级
- `v0.4.0`、`v0.5.0` 是 2026-10-15 从原来的 `v1.0.0`、`v1.1.0` 改名来的，对应提交里写的版本号仍是 1.0.0、1.1.0，检出这两个 tag 构建出的 xpi 版本号和 tag 对不上
- `npm test` 68 个用例，67 过 1 跳过（连真实账号的那个没配 Token 时自动跳过）
- 本机 Zotero 10.0.5 上走通了完整链路；墨墨侧查词、建词本、追加词进词本、加入学习计划四条写读路径都在真实账号上执行过
- main 受 GitHub Ruleset 保护：不能直接推送，改动走 PR，CI 的 `check`（`npm ci`、lint、test、build）通过才能合并

## 下一步

功能上的下一步以 [SCOPE.md](SCOPE.md) 的「下一步」为准。工程上还有两件：

1. 加发布 workflow：推送 `v*` tag 时自动构建 xpi、建 Release。现在是手动的，步骤见下面「发布」
2. 在 Zotero 7、8、9 上实测。manifest 声称支持 6.999–10.*，但只在 10.0.5 上验过

## 发布

1. 改 `package.json` 的 `version`，`addon/manifest.json` 和 `package-lock.json` 里的版本号一起改
2. `npm run build`：生成 `dist/zotero-maimemo-<版本>.xpi`，并按新版本重写 `update.json`
3. 走 PR 合并到 main
4. 在合并后的提交上打附注 tag `v<版本>` 并推送
5. `gh release create v<版本> dist/zotero-maimemo-<版本>.xpi`

`update.json` 一合并就会指向新版本的下载地址，Release 建好之前，已安装用户的更新检查会落空，所以 3 到 5 步之间别隔太久。

## README 里的视频和流程图

- `node scripts/demo-video/render.mjs` 生成 `attachments/演示视频.mp4`。需要本机有 uv 和 ffmpeg；旁白用 edge-tts 合成，字幕文字会发到微软的语音服务，结果缓存在 `out/narration/`
- `node scripts/app-guide/render.mjs` 生成 `docs/imgs/` 下的三张流程图
- 原始截图在 `attachments/Pictures/`，里面有明文 Token 和 UID，整个 `attachments/` 已 gitignore，只在本机。换截图后要改脚本里量好的坐标
- 视频要先在一个提交了的 issue 里上传拿链接（草稿里的附件访客打不开，现在的视频挂在 issue #1）；README 里把链接单独放一行，手写 `<video>` 会被仓库页面的 CSP 拦下

## 验证脚本的已知问题

前置验证脚本 `scripts/verify-maimemo.sh` 读根目录 `.env` 的 `MAIMEMO_TOKEN`，结果写到 `out/`（gitignore，不在版本库里）。审过但没修，跑之前心里有数：

- `out/raw/` 的编号每次从 001 重来，重跑会覆盖上一次的原始响应；`results.tsv` 和 `summary.md` 每次被截断。2026-10-04 那轮 coverage 的汇总就是这么丢的，只剩 `coverage.csv`
- curl 没设超时，连接挂住会一直等
- `--word` 不做 URL 编码，词里带 `&` 会静默查成别的词
- `.env` 解析不认 `export` 前缀，也不剥行尾空格和 CR
- DELETE 若返回 204 会被判成失败

## 必须记住的约束

- 路径是 `https://open.maimemo.com/open` + `/api/v1/memo/...`。[2026-09-21 的实测](2026-09-21-api-probe.md)用的是不带 `memo` 的路径，也能通，但官方文档里没有，不要再用
- **`applications.zotero.update_url` 不能从 manifest 里删掉**，Zotero 10 缺了它拒绝安装，
  却报「可能无法与该版本的 Zotero 兼容」，会把人引到版本号上白查一轮
- 新建云词本的 `content` 不能为空，空串返回 400 `notepad_invalid_content`。官方文档没写这条
- `query_study_records` 的 `tags` 过滤传 `WELL_FAMILIAR` 会返回 400，传 `STICKING` 正常。返回的记录里 `tags` 是数组不是文档写的字符串
- 频控 10 秒 20 次、60 秒 40 次、5 小时 2000 次。**每天 600 条的创建配额对本项目不适用**，那个只计例句、助记、释义
- 墨墨没有 refresh token。token 是 43 字符不透明串，有效期读不出来，失效的唯一信号是 401 + `common_unauthorized`
- token 用 App 内「我的 → 更多设置 → 实验功能 → 开放 API」那个，不要明文贴进对话
- 官方 OpenAPI 文档是 SPA，抓不到正文，要下载 yaml 看

## 未决

- Zotero 7、8、9 里 `renderTextSelectionPopup` 这套 API 还在不在，没实测
- 2026-10-08 验证时在账号里留了两个以 `[可删]` 开头的词本，现在是否还在没核对
