import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { unzipSync, strFromU8 } from "fflate";
import { createHost } from "../helpers/fakes.mjs";

test("XPI 包结构完整，真实打包代码可经 bootstrap 加载并注销", async () => {
  const project = fileURLToPath(new URL("../../", import.meta.url));
  await promisify(execFile)(process.execPath, ["scripts/build.mjs"], { cwd: project });
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  const zipped = await readFile(new URL(`../../dist/${pkg.name}-${pkg.version}.xpi`, import.meta.url));
  const files = unzipSync(zipped);
  assert.deepEqual(Object.keys(files).sort(), ["bootstrap.js", "content/icon.svg", "content/preferences.css", "content/preferences.xhtml", "content/runtime.js", "manifest.json"]);
  const manifest = JSON.parse(strFromU8(files["manifest.json"]));
  assert.equal(manifest.applications.zotero.strict_min_version, "6.999");
  assert.equal(manifest.version, pkg.version);
  const runtime = strFromU8(files["content/runtime.js"]);
  assert.equal(runtime.includes("fixture-token"), false);
  assert.equal(/\b[a-f0-9]{64}\b/i.test(runtime), false);
  const host = createHost();
  const sandbox = vm.createContext({ ...host, URL,
    ChromeUtils: { importGlobalProperties() {}, importESModule() { return host.timers; } },
  });
  sandbox.Services.scriptloader = { loadSubScript(uri, scope) {
    assert.equal(uri, "file:///package/content/runtime.js");
    vm.runInNewContext(runtime, scope);
  } };
  vm.runInContext(strFromU8(files["bootstrap.js"]), sandbox);
  await sandbox.startup({ id: manifest.applications.zotero.id, rootURI: "file:///package/" }, 1);
  assert.equal(host.listeners.size, 1);
  assert.equal(host.panes.size, 1);
  assert.ok(host.Zotero.WordSyncMaimemo?.alive);
  await sandbox.shutdown({}, 1);
  assert.equal(host.listeners.size, 0);
  assert.equal(host.panes.size, 0);
  assert.equal(host.timers.tasks.size, 0);
});
