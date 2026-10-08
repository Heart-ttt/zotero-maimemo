import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { SettingsPage } from "../../src/ui/settings-page.mjs";
import { SettingsService } from "../../src/application/settings-service.mjs";
import { ZoteroCredentials, ZoteroPreferences } from "../../src/integrations/zotero/settings-adapters.mjs";
import { InMemoryWordStore } from "../../src/infrastructure/in-memory-word-store.mjs";
import { createHost, settle } from "../helpers/fakes.mjs";

test("设置页草稿连接测试只读；保存、留空保留、清除凭据，开关单独保存", async () => {
  const markup = await readFile(new URL("../../addon/content/preferences.xhtml", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { contentType: "application/xhtml+xml" });
  const host = createHost({ token: "saved-secret" });
  const ownLogin = { hostname: "chrome://zotero", httpRealm: "Zotero Sync Server", password: "own-secret" };
  host.logins.push(ownLogin);
  const requests = [];
  const credentials = new ZoteroCredentials(host);
  const settings = new SettingsService({
    preferences: new ZoteroPreferences(host), credentials,
    createDirectory: (token) => {
      requests.push(token);
      return {
        async list() { return [{ id: "target", title: "Zotero 背诵" }]; },
        async get(id) { return { id, title: "Zotero 背诵" }; },
        async create({ title }) { return { id: "created", title }; },
      };
    },
  });
  let retries = 0;
  const worker = { subscribe(fn) { fn({ message: "等待加入单词" }); return () => {}; }, async retry() { retries++; } };
  const changes = [];
  const page = new SettingsPage({
    root: dom.window.document.documentElement, settings, store: new InMemoryWordStore(), worker,
    onConfigurationChange: async (action, options) => { changes.push(options.resume); return action(); },
  });
  await page.mount();
  assert.equal(page.token.value, "");
  assert.equal(page.studyPlan.checked, true);
  page.token.value = "draft-secret";
  page.query("test").click();
  await settle();
  assert.deepEqual(requests, ["draft-secret"]);
  assert.equal(await credentials.getToken(), "saved-secret");
  assert.equal(changes.length, 0);
  page.studyPlan.checked = false;
  page.query("save").click();
  await settle();
  assert.equal(await credentials.getToken(), "draft-secret");
  assert.equal(page.token.value, "");
  assert.equal(new ZoteroPreferences(host).getStudyPlanEnabled(), false);
  assert.equal([...host.prefs.values()].some((value) => String(value).includes("secret")), false,
    "Token 不能落进 prefs");
  page.query("save").click();
  await settle();
  assert.equal(await credentials.getToken(), "draft-secret");
  page.query("retry").click();
  await settle();
  assert.equal(retries, 1);
  page.query("clear").click();
  await settle();
  assert.equal(await credentials.getToken(), null);
  assert.deepEqual(changes, [true, true, false]);
  assert.ok(host.logins.includes(ownLogin));
  page.dispose();
  dom.window.close();
});

test("设置页能查词本、选词本、新建词本，选完立刻恢复同步", async () => {
  const markup = await readFile(new URL("../../addon/content/preferences.xhtml", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { contentType: "application/xhtml+xml" });
  const host = createHost({ token: "saved-secret" });
  const created = [];
  const preferences = new ZoteroPreferences(host);
  const settings = new SettingsService({
    preferences, credentials: new ZoteroCredentials(host),
    createDirectory: () => ({
      async list() {
        return [{ id: "a", title: "论文生词" }, { id: "b", title: "考研" }];
      },
      async get(id) { return { id, title: "论文生词" }; },
      async create({ title }) { created.push(title); return { id: "new", title }; },
    }),
  });
  const worker = { subscribe(fn) { fn({ message: "等待加入单词" }); return () => {}; }, async retry() {} };
  const changes = [];
  const page = new SettingsPage({
    root: dom.window.document.documentElement, settings, store: new InMemoryWordStore(), worker,
    onConfigurationChange: async (action, options) => { changes.push(options.resume); return action(); },
  });
  await page.mount();

  assert.match(page.query("notepad-state").textContent, /尚未选择云词本/);

  page.query("notepad-refresh").click();
  await settle();
  assert.deepEqual([...page.notepadList.options].map((option) => option.textContent), ["论文生词", "考研"]);
  assert.equal(preferences.getNotepad(), null, "只是查询，不该改配置");
  assert.deepEqual(changes, [], "查询不触发同步配置变更");

  page.notepadList.value = "b";
  page.query("notepad-select").click();
  await settle();
  assert.deepEqual(preferences.getNotepad(), { id: "b", title: "考研" });
  assert.match(page.query("notepad-state").textContent, /考研/);
  assert.deepEqual(changes, [true], "换词本后要恢复队列");

  page.notepadTitle.value = "  新词本  ";
  page.query("notepad-create").click();
  await settle();
  assert.deepEqual(created, ["新词本"], "名称前后的空格要去掉再提交");
  assert.deepEqual(preferences.getNotepad(), { id: "new", title: "新词本" });

  page.dispose();
  dom.window.close();
});
