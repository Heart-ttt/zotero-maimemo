# zotero-wordsync-maimemo

在 Zotero 阅读器里划词，把词加进墨墨的云词本和学习计划。不用先建注释，划中点一下就进队列。

## 现状

0.1.0 可安装。`npm run build` 出 `dist/zotero-wordsync-maimemo-0.1.0.xpi`。

做了这些：

- 阅读器划词后，在 Zotero 原生的选中弹窗里多出一块。选区有多个词时列出来让你点一个
- 自动还原成原形（`ablations` → `ablation`，`taught` → `teach`），结果可以当场改
- 动词原形和分词形容词在墨墨是两个词条（`attenuate` / `attenuated`），弹窗把两个都列出来让你点，默认原形
- 点「加入」才写入，只写本地队列；不点就什么都不留
- 后台按墨墨的频控限速同步：把词追加进你选定的云词本，再加进学习计划
- 认证失效会暂停队列并提示重填 Token，不在阅读中途打断
- 设置页填 Token、查询账号里的云词本并选一个、直接新建词本、开关「加入学习计划」、测试连接（只读）

没做例句、没做文献出处、没做按分类分词本。只同步单词本身。

## 使用前提

Token 走 App 内「我的 → 更多设置 → 实验功能 → 开放 API」，填进插件设置页。

然后在设置页点「查询云词本」选一个，或者填个名字点「新建并使用」。没选词本之前同步不会开始，设置页会直说。词本认的是 id，你之后在 App 里改名不影响同步。

## 为什么不直接用现成的

Zotero 侧已有两个插件做「生词进墨墨」：

- [zotero-hover-translate-eudic](https://github.com/SHANGKAIJIE/zotero-hover-translate-eudic)（12 star）：PDF 里划词翻译，弹窗点 `+` 加入云词本，墨墨 / 欧路 / 扇贝等五平台可选
- [zotero-maimemo-sync](https://github.com/bulletproof-system/zotero-maimemo-sync)（5 star）：批量把 Zotero 注释推成云词本，无 release

区别在两处。一是操作：它们要你先在 Zotero 里建注释，再去侧栏选词本，再选追加还是覆盖；这里是划词点一下，词本在设置里选一次就固定，永远增量追加且不重复写。二是落点：它们只把词写进云词本，词躺在本子里不会自己进复习；这里用 `study/add_words` 直接送进学习计划。

## 开发

```bash
npm test        # node --test，50 个用例
npm run build   # 打 xpi
```

`tests/integrations/maimemo-live.test.mjs` 会打真实接口，默认跳过，要跑得同时给 `RUN_MAIMEMO_LIVE=1` 和 `MAIMEMO_TOKEN`。

## 文档

- 范围与已知限制 → [docs/SCOPE.md](docs/SCOPE.md)
- 进度与待办 → [docs/HANDOFF.md](docs/HANDOFF.md)
- 墨墨 API 实测 → [docs/2026-09-21-api-probe.md](docs/2026-09-21-api-probe.md)
- 竞品调研 → [docs/2026-09-21-survey.md](docs/2026-09-21-survey.md)
