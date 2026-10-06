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
manifest.version = pkg.version;
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
