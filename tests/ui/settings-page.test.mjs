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
    resolveNotepad: async (token) => { requests.push(token); return { id: "target", title: "Zotero 背诵" }; },
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
  assert.equal([...host.prefs.values()].some((value) => typeof value === "string"), false);
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
