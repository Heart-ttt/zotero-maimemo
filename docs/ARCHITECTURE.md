# 架构与接入说明

2026-10-05 更新。插件只连接 Zotero 和墨墨背单词，统一目标云词本为「Zotero 背诵」。

## 模块职责

`src/domain` 定义单词记录、原形规范化和选区规则，完全不依赖 Zotero、文件和网络。记录只包含一个原文词、确认后的原形及同步进度。

`src/application` 组织加入、设置和同步流程。`WordCaptureService` 校验原文词仍来自选区，允许用户修改原形；`WordSyncService` 分别保存词本和学习计划两步结果；`SyncWorker` 串行消费队列、退避重试、暂停失效认证。界面不会直接调用墨墨写接口。

`src/infrastructure` 实现本地存储和共享请求调度。`JsonWordStore` 通过串行事务提交文件快照，写入成功后才更新内存。插入与原形查重处于同一事务，多个弹窗同时加入也只产生一条记录。读取损坏文件时保留原文件并停止写入。`RateLimitedTransport` 对后台任务和设置页的连接测试使用同一滑动窗口，并在 429 后冷却。

`src/integrations/maimemo` 封装接口与返回校验。词本网关先读取原内容，再只追加缺少的一行，保留章节、空行、缩进和换行格式，仅提交合法可写字段。学习计划网关先查单词 ID，再提交 `words: [{ id }]`；新增数不足时查询已有学习记录，未确认就保留 `partial`。

`src/integrations/zotero` 封装宿主依赖。单词文件放在 Zotero 数据目录的 `wordsync-maimemo.json`，由 Zotero 文件工具原子替换。Token 使用 `Services.logins` 的独立认证域 `WordSync Maimemo API`，不会读写 Zotero 同步账号凭据。普通 prefs 仅保存学习计划开关。HTTP 使用 Zotero 官方工具，并隔离可能带请求信息的原生异常。

`src/ui` 分别实现阅读器弹窗和设置页。弹窗用修订号防止旧异步查询覆盖新选词状态；点加入时固定词和原形，忙碌期间禁止重复点击。关闭弹窗时释放事件、观察器和状态订阅。设置页只读测试草稿 Token，保存才修改配置；清除凭据会中止当前同步。

`src/plugin/runtime.mjs` 是组装入口，负责注入依赖、注册和注销阅读器钩子与偏好页，以及插件升级、禁用时的清理。`addon/bootstrap.js` 仅加载打包模块并转发生命周期，不承担单词业务。

## 架构参考及检查

检查了 [zotero-plugin-template 的 hooks](https://github.com/windingwind/zotero-plugin-template/blob/main/src/hooks.ts)、bootstrap 和 manifest，采用其生命周期与业务模块分离的方式。它的示例包含工具箱、菜单、翻译与演示代码，本项目用官方接口自行实现所需部分，避免引入无关模块。模板及此前调研的竞品有 AGPL 许可，未将其代码直接复制进项目，也未将它们标成 MIT。

阅读器与设置注册方式逐项核对了本机 Zotero 10.0.5 的 `reader.js`、`preferencePanes.js`、`preferences.js`；文件原子替换及凭据使用方式核对了 `file.js` 和 `syncLocal.js`。设置片段是 XUL 容器包裹的 HTML，等宿主触发 `load` 后才绑定 DOM。

接口字段核对了墨墨当前 [OpenAPI 文件](https://open.maimemo.com/api_bundle.yaml)，并交叉检查 [非官方 SDK](https://github.com/fuhan666/maimemo-sdk) 的类型定义。本次客户端使用当前官方 `/api/v1/memo/*` 路径，历史验证脚本使用的旧路径仍保留在历史文档里。SDK 仅作为字段参考，未直接引入其代码或依赖。

## 当前限制

词形还原仍使用原词作为初始值，用户需在弹窗中确认或修改；自动还原和词义来源尚未实现。管理界面提供最近记录与重试，移除、清空和同步后撤销尚未实现。

云词本接口需要整本读后更新；本插件内部已串行化，但接口没有已确认的条件写入机制，不能保证同时在墨墨 App 或其他客户端修改同一词本时完全避免竞争。请求频控只维护本次插件运行的记录，重启后的历史计数和其他客户端流量依赖服务端 429 控制。首次打开长时窗口的限流等待暂时没有单独的倒计时显示。

插件声明支持 Zotero 7–10。离线测试覆盖 DOM、宿主替身、持久化、队列、HTTP 字段和打包后的 bootstrap 加载；本机 Zotero 10.0.5 已完成安装、阅读器弹窗、设置页和本地队列验证，真实墨墨写接口仍未执行账号写入。
