import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { SettingsPage } from "../../src/ui/settings-page.mjs";
import { SettingsService } from "../../src/application/settings-service.mjs";
import { ZoteroCredentials, ZoteroPreferences } from "../../src/integrations/zotero/settings-adapters.mjs";
import { InMemoryWordStore } from "../../src/infrastructure/in-memory-word-store.mjs";
import { createHost, settle } from "../helpers/fakes.mjs";

test("Token 明文回填、改动即存、连接测试只读且结果染色", async () => {
  const markup = await readFile(new URL("../../addon/content/preferences.xhtml", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { contentType: "application/xhtml+xml" });
  const host = createHost({ token: "saved-secret" });
  const ownLogin = { hostname: "chrome://zotero", httpRealm: "Zotero Sync Server", password: "own-secret" };
  host.logins.push(ownLogin);
  const requests = [];
  const credentials = new ZoteroCredentials(host);
  let failNext = false;
  const settings = new SettingsService({
    preferences: new ZoteroPreferences(host), credentials,
    createDirectory: (token) => {
      requests.push(token);
      return {
        async list() {
          if (failNext) throw new Error("Token 无效或已失效，请重新填写");
          return [{ id: "target", title: "Zotero 背诵" }];
        },
        async get(id) { return { id, title: "Zotero 背诵" }; },
        async create({ title }) { return { id: "created", title }; },
      };
    },
  });
  await settings.selectNotepad({ id: "target", title: "Zotero 背诵" });
  let retries = 0;
  const worker = { subscribe(fn) { fn({ message: "等待加入单词" }); return () => {}; }, async retry() { retries++; } };
  const changes = [];
  const page = new SettingsPage({
    root: dom.window.document.documentElement, settings, store: new InMemoryWordStore(), worker,
    onConfigurationChange: async (action, options) => { changes.push(options.resume); return action(); },
  });
  const change = (element) => element.dispatchEvent(new dom.window.Event("change"));

  await page.mount();
  assert.equal(page.token.value, "saved-secret", "Token 明文回填，不再用占位提示打哑谜");
  assert.equal(page.token.type, "text");
  assert.equal(page.studyPlan.checked, true);
  assert.equal(page.query("save"), null, "保存按钮已去掉");

  // 连接测试只读：用输入框里的草稿，不写凭据、不动队列。
  page.token.value = "draft-secret";
  page.query("test").click();
  await settle();
  // 挂载时用已存 Token 拉过一次；测试连接用草稿 Token 再拉一次，就这一次。
  assert.deepEqual(requests, ["saved-secret", "draft-secret"]);
  assert.equal(await credentials.getToken(), "saved-secret");
  assert.deepEqual(changes, []);
  assert.ok(page.testResult.classList.contains("wordsync-test-ok"), "通了小字变绿");
  assert.equal(page.testButton.classList.contains("wordsync-test-ok"), false, "按钮本身不变色");
  assert.equal(page.testResult.textContent, "连接成功！", "只报连接结果，不提词本");
  assert.deepEqual([...page.notepadList.options].map((option) => option.textContent), ["Zotero 背诵"],
    "连上了就顺手把词本列表拉下来");

  // 失败时变红，原因写在下面那行。
  failNext = true;
  page.query("test").click();
  await settle();
  assert.ok(page.testResult.classList.contains("wordsync-test-bad"), "没通小字变红");
  assert.equal(page.testResult.classList.contains("wordsync-test-ok"), false);
  assert.match(page.testResult.textContent, /Token 无效或已失效/);
  failNext = false;

  // 改动即存：Token 的 change、开关的 change 各自落盘。
  change(page.token);
  await settle();
  assert.equal(await credentials.getToken(), "draft-secret");
  assert.equal(page.token.value, "draft-secret", "保存后不清空输入框");
  assert.deepEqual(changes, [true]);

  page.studyPlan.checked = false;
  change(page.studyPlan);
  await settle();
  assert.equal(new ZoteroPreferences(host).getStudyPlanEnabled(), false);
  assert.deepEqual(changes, [true, true]);

  page.query("retry").click();
  await settle();
  assert.equal(retries, 1);

  page.query("clear").click();
  await settle();
  assert.equal(await credentials.getToken(), null);
  assert.equal(page.token.value, "");
  assert.deepEqual(changes, [true, true, false]);

  assert.equal([...host.prefs.values()].some((value) => String(value).includes("secret")), false,
    "Token 不能落进 prefs");
  assert.ok(host.logins.includes(ownLogin), "不碰 Zotero 自己的登录项");
  page.dispose();
  dom.window.close();
});

test("列表自动加载；新建只建不用；点「使用所选词本」才生效并标绿", async () => {
  const markup = await readFile(new URL("../../addon/content/preferences.xhtml", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { contentType: "application/xhtml+xml" });
  const host = createHost({ token: "saved-secret" });
  const created = [];
  const preferences = new ZoteroPreferences(host);
  let notepads = [{ id: "a", title: "论文生词" }, { id: "b", title: "考研" }];
  const settings = new SettingsService({
    preferences, credentials: new ZoteroCredentials(host),
    createDirectory: () => ({
      async list() { return notepads; },
      async get(id) { return { id, title: "论文生词" }; },
      async create({ title }) {
        created.push(title);
        const notepad = { id: "new", title };
        notepads = [...notepads, notepad];
        return notepad;
      },
    }),
  });
  const worker = { subscribe(fn) { fn({ message: "等待加入单词" }); return () => {}; }, async retry() {} };
  const changes = [];
  const page = new SettingsPage({
    root: dom.window.document.documentElement, settings, store: new InMemoryWordStore(), worker,
    onConfigurationChange: async (action, options) => { changes.push(options.resume); return action(); },
  });
  await page.mount();
  await settle();

  // 没有「查询云词本」按钮了，列表在挂载时自己拉下来。
  assert.equal(page.query("notepad-refresh"), null);
  assert.deepEqual([...page.notepadList.options].map((option) => option.textContent), ["论文生词", "考研"]);
  assert.equal(preferences.getNotepad(), null, "只是列出来，没有替用户做选择");
  assert.equal(page.chosenMark.hidden, true, "还没选，不该标已选择");
  assert.equal(page.notepadList.classList.contains("wordsync-chosen"), false);
  assert.deepEqual(changes, []);

  // 新建只建，不接管当前词本，但把光标停在新词本上。
  page.notepadTitle.value = "  新词本  ";
  page.query("notepad-create").click();
  await settle();
  assert.deepEqual(created, ["新词本"], "名称前后的空格要去掉再提交");
  assert.equal(preferences.getNotepad(), null, "新建不等于启用");
  assert.equal(page.notepadList.value, "new", "建完把它选上，省得再翻一遍列表");
  assert.equal(page.chosenMark.hidden, true);
  assert.deepEqual(changes, [], "新建不动同步配置");

  // 点「使用所选词本」才真的换，换完标绿。
  page.query("notepad-select").click();
  await settle();
  assert.deepEqual(preferences.getNotepad(), { id: "new", title: "新词本" });
  assert.equal(page.chosenMark.hidden, false);
  assert.ok(page.notepadList.classList.contains("wordsync-chosen"));
  assert.deepEqual(changes, [true], "换词本后要恢复队列");

  // 在列表里改选别的，绿色要撤掉——那个还没生效。
  page.notepadList.value = "b";
  page.notepadList.dispatchEvent(new dom.window.Event("change"));
  await settle();
  assert.equal(page.chosenMark.hidden, true);
  assert.equal(page.notepadList.classList.contains("wordsync-chosen"), false);

  page.dispose();
  dom.window.close();
});

test("填完 Token 直接点测试连接不会被自动保存吃掉", async () => {
  const markup = await readFile(new URL("../../addon/content/preferences.xhtml", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { contentType: "application/xhtml+xml" });
  const host = createHost();
  const credentials = new ZoteroCredentials(host);
  const calls = [];
  const settings = new SettingsService({
    preferences: new ZoteroPreferences(host), credentials,
    createDirectory: (token) => ({
      async list() { calls.push(token); return []; },
      async get(id) { return { id, title: "x" }; },
      async create({ title }) { return { id: "new", title }; },
    }),
  });
  const worker = { subscribe(fn) { fn({ message: "等待加入单词" }); return () => {}; }, async retry() {} };
  const page = new SettingsPage({
    root: dom.window.document.documentElement, settings, store: new InMemoryWordStore(), worker,
    onConfigurationChange: async (action) => action(),
  });
  await page.mount();
  await settle();

  // 真实顺序：点击让输入框失焦先触发 change（自动保存），再触发 click。
  page.token.value = "pasted-token";
  page.token.dispatchEvent(new dom.window.Event("change"));
  page.query("test").click();
  await settle();
  await page.pending;
  await settle();

  assert.equal(await credentials.getToken(), "pasted-token", "自动保存要生效");
  assert.deepEqual(calls, ["pasted-token"], "测试连接也要真的跑掉，不能被吞；而且只发一次请求");
  assert.equal(page.testResult.textContent, "连接成功！");
  page.dispose();
  dom.window.close();
});

test("列表拉不下来时，仍然看得出正在用哪个词本", async () => {
  const markup = await readFile(new URL("../../addon/content/preferences.xhtml", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { contentType: "application/xhtml+xml" });
  const host = createHost({ token: "saved-secret" });
  const preferences = new ZoteroPreferences(host);
  const settings = new SettingsService({
    preferences, credentials: new ZoteroCredentials(host),
    createDirectory: () => ({
      async list() { throw new Error("无法连接墨墨，请检查网络后重试"); },
      async get(id) { return { id, title: "论文生词" }; },
      async create({ title }) { return { id: "new", title }; },
    }),
  });
  await settings.selectNotepad({ id: "a", title: "论文生词" });
  const worker = { subscribe(fn) { fn({ message: "等待加入单词" }); return () => {}; }, async retry() {} };
  const page = new SettingsPage({
    root: dom.window.document.documentElement, settings, store: new InMemoryWordStore(), worker,
    onConfigurationChange: async (action) => action(),
  });
  await page.mount();
  await settle();

  assert.deepEqual([...page.notepadList.options].map((option) => option.textContent), ["论文生词"],
    "退回本地记着的那个词本");
  assert.equal(page.chosenMark.hidden, false, "它确实是正在用的，该标绿");
  assert.match(page.message.textContent, /无法连接墨墨/, "同时说明为什么没拉到列表");
  page.dispose();
  dom.window.close();
});
