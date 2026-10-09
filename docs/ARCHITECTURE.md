# 架构与接入说明

2026-10-09 更新。插件只连接 Zotero 和墨墨背单词，目标云词本在设置页里选，存的是词本 id。

## 模块职责

`src/domain` 定义单词记录、原形规范化、词形还原和选区规则，完全不依赖 Zotero、文件和网络。记录只包含一个原文词、确认后的原形及同步进度。`lemmatizer.mjs` 按规则还原词形，`lemmaCandidates` 给词库仲裁用（含拼写猜测的词干），`lemmaChoices` 给人看（只有像样的词）。

`src/application` 组织加入、设置和同步流程。`WordCaptureService` 校验原文词仍来自选区，允许用户修改原形；`WordSyncService` 分别保存词本和学习计划两步结果；`SyncWorker` 串行消费队列、退避重试、暂停失效认证。界面不会直接调用墨墨写接口。

`src/infrastructure` 实现本地存储和共享请求调度。`JsonWordStore` 按行追加：一条记录一行，后写的覆盖先写的，启动时重放得到当前状态，行数积到记录数两倍加富余量才整理一次。写入成功后才更新内存；插入与原形查重处于同一事务，多个弹窗同时加入也只产生一条记录。末行可能是崩溃时写了一半，丢掉即可；前面没有任何有效行则判定整个文件损坏，保留原文件并停止写入。`RateLimitedTransport` 对后台任务和设置页的连接测试使用同一滑动窗口，并在 429 后冷却。

`src/integrations/maimemo` 封装接口与返回校验。词本网关先读取原内容，再只追加缺少的一行，保留章节、空行、缩进和换行格式，仅提交合法可写字段。学习计划网关先查单词 ID，再提交 `words: [{ id }]`；新增数不足时查询已有学习记录，未确认就保留 `partial`。

`src/integrations/zotero` 封装宿主依赖。单词文件放在 Zotero 数据目录的 `wordsync-maimemo.json`，由 Zotero 文件工具原子替换。Token 使用 `Services.logins` 的独立认证域 `WordSync Maimemo API`，不会读写 Zotero 同步账号凭据。普通 prefs 仅保存学习计划开关。HTTP 使用 Zotero 官方工具，并隔离可能带请求信息的原生异常。

`src/ui` 分别实现阅读器弹窗和设置页。弹窗挂进 Zotero 原生的选中弹窗，列出选区里的词和选中词的词形候选；用修订号防止旧异步查询覆盖新选词状态，点加入时固定词和原形，忙碌期间禁止重复点击。关闭时释放事件、观察器和状态订阅。设置页改动即存，没有保存按钮；测试连接只验 Token 且只读；动作串行排队执行，避免输入框失焦触发的自动保存把紧接着的点击吃掉。

`src/plugin/runtime.mjs` 是组装入口，负责注入依赖、注册和注销阅读器钩子与偏好页，以及插件升级、禁用时的清理。`addon/bootstrap.js` 仅加载打包模块并转发生命周期，不承担单词业务。

## 架构参考及检查

检查了 [zotero-plugin-template 的 hooks](https://github.com/windingwind/zotero-plugin-template/blob/main/src/hooks.ts)、bootstrap 和 manifest，采用其生命周期与业务模块分离的方式。它的示例包含工具箱、菜单、翻译与演示代码，本项目用官方接口自行实现所需部分，避免引入无关模块。模板及此前调研的竞品有 AGPL 许可，未将其代码直接复制进项目，也未将它们标成 MIT。

阅读器与设置注册方式逐项核对了本机 Zotero 10.0.5 的 `reader.js`、`preferencePanes.js`、`preferences.js`；文件原子替换及凭据使用方式核对了 `file.js` 和 `syncLocal.js`。设置片段是 XUL 容器包裹的 HTML，等宿主触发 `load` 后才绑定 DOM。

接口字段核对了墨墨当前 [OpenAPI 文件](https://open.maimemo.com/api_bundle.yaml)，并交叉检查 [非官方 SDK](https://github.com/fuhan666/maimemo-sdk) 的类型定义。本次客户端使用当前官方 `/api/v1/memo/*` 路径，历史验证脚本使用的旧路径仍保留在历史文档里。SDK 仅作为字段参考，未直接引入其代码或依赖。

## 当前限制

词形还原是本地规则，不查词典，所以靠拼写分不开的几类会猜错（`bias` 削成 `bia`，派生形式不还原）；候选都留着，弹窗里可当场改。词义来源尚未实现 —— 墨墨开放 API 不提供词典释义，要显示只能接第三方。管理界面提供最近记录与重试，移除、清空和同步后撤销尚未实现。

云词本接口需要整本读后更新；本插件内部已串行化，但接口没有已确认的条件写入机制，不能保证同时在墨墨 App 或其他客户端修改同一词本时完全避免竞争。请求频控只维护本次插件运行的记录，重启后的历史计数和其他客户端流量依赖服务端 429 控制。首次打开长时窗口的限流等待暂时没有单独的倒计时显示。

插件声明的最低版本是 6.999（Zotero 7 起的惯例写法），上限 10.*，本机 `Zotero.version` 为 10.0.5，落在区间内。

**`applications.zotero.update_url` 不能删。** 2026-10-09 把它删掉之后 Zotero 10.0.5 拒绝安装，提示「可能无法与该版本的 Zotero 兼容」—— 一句跟版本号毫无关系的话，很容易让人去改 `strict_min_version`，实际上改了也没用。构建时如果 `package.json` 填了 `repository` 就把它覆盖成 GitHub 上的真实地址，没填则沿用 manifest 里的默认值；无论哪种情况字段都必须存在，构建会校验。离线测试覆盖 DOM、宿主替身、持久化、队列、HTTP 字段和打包后的 bootstrap 加载；本机 Zotero 10.0.5 上走通了完整链路，墨墨侧的查词、建词本、追加词进词本、加入学习计划四条写读路径都已在真实账号上执行过。

## 代码约定

JavaScript 没有 PEP 8 那样的官方规范，这个项目把约定写成可执行的 ESLint 规则，放在 `eslint.config.mjs`，`npm run lint` 检查。

能由规则管的交给规则：每行不超过 110 字符、一行最多两条语句、标识符至少三个字符（`id`、`ok` 等少数几个除外）、禁止 `var`、要求 `const`、强制 `===`、禁止改写参数。墨墨接口回传的 `voc_id`、`added_count` 这类下划线字段在白名单里，不强行改成驼峰。

规则管不了的靠约定：

- 注释用中文，解释「为什么这么做」而不是复述代码在做什么。踩过的坑要写进注释，比如空 `content` 会被墨墨拒掉、`calling` 不能去重复辅音。
- 不为少写几个字符牺牲可读性。接口方法即使只是把下游 Promise 原样返回也标 `async`，调用方一眼看得出这是异步的；`require-await` 这条规则因此没有开启。
- 命名写全，不用 `a`、`tmp` 这类。外部接口带进来的名字（`doc`、`msg`、`dir`）保持原样，不另起别名。
- 函数超过几十行就按职责拆开。设置页的 `mount()` 拆成 `cacheElements`、`bindTokenSection`、`bindNotepadSection`、`bindOptionsSection`、`bindSyncSection`、`bindLifecycle`、`loadInitialState`，mount 本身只剩一张目录。
- 大段静态内容（弹窗样式）提到模块顶层常量，别埋在构建 DOM 的函数里。
