import { build } from "esbuild";
import { zipSync, strToU8 } from "fflate";
import { readFile, readdir, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(project, "addon");
const output = path.join(project, "dist");
const staging = path.join(output, "addon");
const pkg = JSON.parse(await readFile(path.join(project, "package.json"), "utf8"));
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(pkg.version)) {
  throw new Error(`package.json version 不是有效的 semver: ${pkg.version}`);
}
const releaseTag = process.env.RELEASE_TAG || process.env.GIT_TAG;
if (releaseTag && releaseTag.replace(/^v/, "") !== pkg.version) {
  throw new Error(`版本不一致：package.json=${pkg.version}，tag=${releaseTag}`);
}
await mkdir(output, { recursive: true });
await rm(staging, { recursive: true, force: true });
await mkdir(path.join(staging, "content"), { recursive: true });

const files = {};
async function copyResources(directory, relative = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      await mkdir(path.join(staging, name), { recursive: true });
      await copyResources(path.join(directory, entry.name), name);
    } else {
      const buffer = new Uint8Array(await readFile(path.join(directory, entry.name)));
      files[name] = buffer;
      await writeFile(path.join(staging, name), buffer);
    }
  }
}
await copyResources(source);
const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
if (manifest.version && manifest.version !== pkg.version) {
  // 版本以 package.json 为准，这里只提醒源文件别放着一个对不上的值。
  console.warn(`提醒：addon/manifest.json 的版本是 ${manifest.version}，构建用的是 ${pkg.version}`);
}
manifest.version = pkg.version;

// update_url 必须存在：Zotero 10 缺了这个字段会直接拒绝安装，
// 而且报的是「可能无法与该版本兼容」，跟版本号毫无关系，极易查错方向。
// 仓库地址填了就覆盖成 GitHub 上的真实地址，没填就沿用 manifest 里的默认值。
const slug = String(pkg.repository || "").replace(/^.*github\.com[/:]/, "").replace(/\.git$/, "").replace(/\/$/, "");
const addonID = manifest.applications?.zotero?.id;
if (slug && addonID) {
  const branch = process.env.UPDATE_BRANCH || "main";
  manifest.applications.zotero.update_url =
    `https://raw.githubusercontent.com/${slug}/${branch}/update.json`;
  const updates = {
    addons: {
      [addonID]: {
        updates: [{
          version: pkg.version,
          update_link: `https://github.com/${slug}/releases/download/v${pkg.version}/${pkg.name}-${pkg.version}.xpi`,
          applications: { zotero: { strict_min_version: manifest.applications.zotero.strict_min_version } },
        }],
      },
    },
  };
  await writeFile(path.join(project, "update.json"), JSON.stringify(updates, null, 2) + "\n");
  console.log("已更新 update.json");
} else {
  console.log("package.json 没填 repository，update_url 沿用 manifest 里的默认值，更新检查会 404");
}
if (!manifest.applications?.zotero?.update_url) {
  throw new Error("manifest 缺少 applications.zotero.update_url，Zotero 10 会拒绝安装");
}

files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2) + "\n");
await writeFile(path.join(staging, "manifest.json"), files["manifest.json"]);

await build({
  entryPoints: [path.join(project, "src/plugin/runtime.mjs")],
  outfile: path.join(staging, "content/runtime.js"),
  bundle: true, format: "iife", globalName: "WordSyncBundle",
  platform: "browser", target: "firefox128", charset: "utf8",
  minify: false, legalComments: "inline",
});
files["content/runtime.js"] = new Uint8Array(await readFile(path.join(staging, "content/runtime.js")));
const artifact = path.join(output, `${pkg.name}-${pkg.version}.xpi`);
await writeFile(artifact, zipSync(files, { level: 9 }));
console.log(`已生成插件：${artifact}`);
