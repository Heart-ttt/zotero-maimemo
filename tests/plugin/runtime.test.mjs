import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { WordSyncPlugin, PREFERENCE_PANE_ID } from "../../src/plugin/runtime.mjs";
import { createWordRecord } from "../../src/domain/word-record.mjs";
import { createHost, settle, deferred } from "../helpers/fakes.mjs";

function remoteResponse(data) { return { status: 200, responseText: JSON.stringify({ success: true, data }) }; }
const target = { id: "target", title: "Zotero 背诵", status: "PUBLISHED", brief: "reading", tags: [], content: "// 科研\n\n  apple  \n" };

function createRemoteHost(overrides = {}) {
  let content = target.content;
  const host = createHost({ token: "fixture-token", request: async (method, url, options) => {
    if (overrides.request) return overrides.request(method, url, options);
    if (url.includes("notepads?")) return remoteResponse({ notepads: [{ id: target.id, title: target.title }] });
    if (url.endsWith("/notepads/target") && method === "GET") return remoteResponse({ notepad: { ...target, content } });
    if (url.endsWith("/notepads/target")) { content = JSON.parse(options.body).notepad.content; return remoteResponse({ notepad: { id: "target" } }); }
    if (url.endsWith("/vocabulary/query")) return remoteResponse({ voc: [{ id: "voc-mouse", spelling: "mouse" }] });
    if (url.endsWith("/study/add_words")) return remoteResponse({ added_count: 1 });
    throw new Error(`unexpected request: ${url}`);
  } });
  host.prefs.set("wordsync-maimemo.notepadId", target.id);
  host.prefs.set("wordsync-maimemo.notepadTitle", target.title);
  return host;
}

test("官方阅读器钩子连通本地队列与墨墨两步同步，停用清理后重启恢复", async () => {
  const host = createRemoteHost();
  const plugin = new WordSyncPlugin({ host, pluginID: "test-plugin", rootURI: "file:///addon/", transportOptions: { minimumInterval: 0 } });
  await plugin.start();
  await plugin.start();
  assert.equal(host.listeners.size, 1);
  assert.equal(host.panes.get(PREFERENCE_PANE_ID).src, "file:///addon/content/preferences.xhtml");
  const dom = new JSDOM("<!doctype html><body><div id='native'>原生颜色</div></body>");
  const event = { doc: dom.window.document, params: { annotation: { text: "mice" } }, append: (root) => dom.window.document.body.append(root) };
  const handler = host.listeners.get("renderTextSelectionPopup").handler;
  handler(event);
  handler(event);
  await settle();
  assert.equal(dom.window.document.querySelectorAll(".wordsync-maimemo-popup").length, 1);
  assert.equal((await plugin.store.listAll()).length, 0);
  assert.equal(host.calls.length, 0);
  const popup = [...plugin.popups][0];
  popup.input.value = "mouse";
  popup.input.dispatchEvent(new dom.window.Event("input"));
  await settle();
  popup.addButton.click();
  await settle();
  await plugin.worker.flush();
  const record = (await plugin.store.listAll())[0];
  assert.equal(record.status, "synced");
  assert.equal(record.notepadAddedByPlugin, true);
  const notepadRequest = host.calls.find((call) => call.method === "POST" && call.url.endsWith("/notepads/target"));
  const update = JSON.parse(notepadRequest.options.body);
  assert.equal(update.id, "target");
  assert.equal(update.notepad.content, target.content + "mouse");
  const study = host.calls.find((call) => call.url.endsWith("/study/add_words"));
  assert.deepEqual(JSON.parse(study.options.body), { words: [{ id: "voc-mouse" }], advance: true });
  assert.equal(host.files.get(plugin.file.path).includes("fixture-token"), false);
  await plugin.shutdown();
  assert.equal(host.listeners.size, 0);
  assert.equal(host.panes.size, 0);
  assert.equal(host.timers.tasks.size, 0);
  assert.equal(dom.window.document.querySelectorAll(".wordsync-maimemo-popup").length, 0);
  assert.equal(host.Zotero.WordSyncMaimemo, undefined);
  const restored = new WordSyncPlugin({ host, pluginID: "test-plugin", rootURI: "file:///addon/", transportOptions: { minimumInterval: 0 } });
  await restored.start();
  const previousCalls = host.calls.length;
  await restored.worker.flush();
  assert.equal((await restored.store.listAll())[0].status, "synced");
  assert.equal(host.calls.length, previousCalls);
  await restored.shutdown();
  dom.window.close();
});

test("清除 Token 中止正在进行的同步，之后不再提交学习计划", async () => {
  const write = deferred();
  let started;
  const signal = new Promise((resolve) => { started = resolve; });
  const host = createRemoteHost({ request: async (method, url, options) => {
    if (url.includes("notepads?")) return remoteResponse({ notepads: [{ id: "target", title: target.title }] });
    if (method === "GET") return remoteResponse({ notepad: target });
    if (url.endsWith("/notepads/target")) {
      options.cancellerReceiver(() => write.reject(new Error("cancelled")));
      started();
      return write.promise;
    }
    throw new Error("study must not be called");
  } });
  const plugin = new WordSyncPlugin({ host, pluginID: "test-plugin", rootURI: "file:///addon/", transportOptions: { minimumInterval: 0 } });
  await plugin.start();
  await plugin.store.insert(createWordRecord({ lemma: "mouse", surface: "mice" }));
  const running = plugin.worker.flush();
  await signal;
  await plugin.changeConfiguration(() => plugin.settings.clearToken(), { resume: false });
  await running;
  assert.equal(await plugin.credentials.getToken(), null);
  assert.equal(plugin.worker.state.kind, "authentication");
  assert.equal(host.calls.some((call) => call.url.includes("study/")), false);
  assert.equal((await plugin.store.listPending()).length, 1);
  await plugin.shutdown();
});

test("设置页加载失败时给出可读的错误，不留白屏", async () => {
  const host = createRemoteHost();
  const plugin = new WordSyncPlugin({ host, pluginID: "test-plugin", rootURI: "file:///addon/", transportOptions: { minimumInterval: 0 } });
  await plugin.start();

  // 故意给一段缺元素的界面，模拟设置页在真实 Zotero 里渲染不出来的情形。
  const dom = new JSDOM("<!doctype html><html><body><div id='pane'></div></body></html>");
  const root = dom.window.document.getElementById("pane");
  await plugin.mountPreferences(root);

  assert.match(root.textContent, /设置页加载失败/);
  assert.match(root.textContent, /缺少元素：token/, "要说清楚缺的是哪个元素");
  assert.equal(plugin.settingsPages.size, 0, "失败的页面不留在实例集合里");
  assert.ok(host.debug.some((line) => line.includes("设置页加载失败")), "完整堆栈要进 Zotero 日志");

  await plugin.shutdown();
  dom.window.close();
});
