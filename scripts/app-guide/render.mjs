// 把 README 里的三张操作流程图渲染出来：手机上获取 Token、开启学习数据自动同步，以及 Zotero 里的设置。
//
//   node scripts/app-guide/render.mjs           三张都出
//   node scripts/app-guide/render.mjs zotero    只出一张（token、sync 或 zotero）
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ROOT, withScene } from "../lib/headless-chrome.mjs";

// 手机那两张按 1832 宽排版、1 倍截图；Zotero 那张按 README 显示宽度 800 排版、2 倍截图。
const GUIDES = {
  token: { scene: "scripts/app-guide/phone.html?guide=token", output: "docs/imgs/token-guide.png", width: 1832, scale: 1 },
  sync: { scene: "scripts/app-guide/phone.html?guide=sync", output: "docs/imgs/sync-guide.png", width: 1832, scale: 1 },
  zotero: { scene: "scripts/app-guide/zotero.html", output: "docs/imgs/zotero-guide.png", width: 800, scale: 2 },
};

const requested = process.argv[2];
if (requested && !GUIDES[requested]) throw new Error(`不认识的流程图：${requested}，可选 ${Object.keys(GUIDES).join("、")}`);

for (const name of requested ? [requested] : Object.keys(GUIDES)) {
  const guide = GUIDES[name];
  const output = path.join(ROOT, guide.output);
  const viewport = { width: guide.width, height: 1000, deviceScaleFactor: guide.scale };
  await withScene(guide.scene, viewport, async ({ info, evaluate, resize, screenshot }) => {
    // 页面高度由排版决定，先量出来再把视口调成整页大小。
    await resize({ width: info.width, height: info.height, deviceScaleFactor: guide.scale });
    await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, await screenshot());
    const { size } = await stat(output);
    console.log(`${output}  ${info.width * guide.scale}x${info.height * guide.scale}  ${(size / 1024 / 1024).toFixed(2)} MB`);
  });
}
