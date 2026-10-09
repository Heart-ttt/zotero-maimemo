import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { ReaderPopup } from "../../src/ui/reader-popup.mjs";
import { WordCaptureService } from "../../src/application/word-capture-service.mjs";
import { InMemoryWordStore } from "../../src/infrastructure/in-memory-word-store.mjs";
import { IdentityLemmatizer, RuleLemmatizer } from "../../src/domain/lemmatizer.mjs";
import { createWordRecord } from "../../src/domain/word-record.mjs";
import { deferred, settle } from "../helpers/fakes.mjs";

function mountPopup({ text = "The mice were measured.", store = new InMemoryWordStore() } = {}) {
  const dom = new JSDOM("<!doctype html><body><div id='native'>原生注释颜色</div></body>");
  const listeners = new Set();
  const worker = {
    kicks: 0,
    kick() { this.kicks++; },
    subscribe(listener) { listeners.add(listener); listener({ kind: "idle" }); return () => listeners.delete(listener); },
  };
  const popup = new ReaderPopup({
    event: {
      doc: dom.window.document,
      params: { annotation: { text } },
      append: (root) => dom.window.document.body.append(root),
    },
    store, captureService: new WordCaptureService({ store, lemmatizer: new IdentityLemmatizer() }),
    settings: { async read() { return { addToStudyPlan: false }; } },
    worker, openSettings() {},
  });
  popup.mount();
  return { dom, popup, store, worker, listeners };
}

test("划词与关闭不保存记录，原生注释区域保留", async () => {
  const { popup, store, dom, listeners } = mountPopup();
  await settle();
  assert.deepEqual(await store.listAll(), []);
  popup.root.remove();
  await settle();
  assert.equal(popup.alive, false);
  assert.equal(listeners.size, 0);
  assert.equal(dom.window.document.querySelector("#native").textContent, "原生注释颜色");
  assert.deepEqual(await store.listAll(), []);
  dom.window.close();
});

test("多词选区只加入所选词，可修改原形且重复点击仅保存一次", async () => {
  const { popup, store, worker, dom } = mountPopup();
  popup.selectWord("mice");
  popup.input.value = "mouse";
  popup.input.dispatchEvent(new dom.window.Event("input"));
  await settle();
  popup.addButton.click();
  popup.addButton.click();
  await settle();
  const records = await store.listAll();
  assert.equal(records.length, 1);
  assert.equal(records[0].surface, "mice");
  assert.equal(records[0].lemma, "mouse");
  assert.equal(records[0].addToStudyPlan, false);
  assert.equal("selectionText" in records[0], false);
  assert.equal(worker.kicks, 1);
  assert.equal(popup.addButton.disabled, true);
  popup.dispose();
  dom.window.close();
});

test("快速换词时旧异步结果不覆盖当前词的加入状态", async () => {
  const gates = new Map([['mice', deferred()], ['mouse', deferred()]]);
  const store = { findByLemma: (lemma) => gates.get(lemma).promise };
  const { popup, dom } = mountPopup({ text: "mice mouse", store });
  popup.selectWord("mouse");
  gates.get("mouse").resolve({ ...createWordRecord({ lemma: "mouse", surface: "mouse" }), status: "synced", inNotepad: true });
  await settle();
  gates.get("mice").resolve(null);
  await settle();
  assert.equal(popup.input.value, "mouse");
  assert.equal(popup.addButton.disabled, true);
  assert.equal(popup.addButton.textContent, "已同步");
  popup.dispose();
  dom.window.close();
});

test("修改为句子不能加入，Esc 仍遵循阅读器关闭规则", async () => {
  const { popup, store, dom } = mountPopup({ text: "mouse" });
  popup.input.value = "two words";
  popup.input.dispatchEvent(new dom.window.Event("input"));
  await settle();
  assert.equal(popup.addButton.disabled, true);
  let escaped = false;
  dom.window.document.addEventListener("keydown", (event) => { escaped = event.key === "Escape"; });
  popup.input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(escaped, true);
  assert.deepEqual(await store.listAll(), []);
  popup.dispose();
  dom.window.close();
});

test("选区参数缺少 annotation.text 时使用阅读器当前选区", async () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  dom.window.getSelection = () => ({ toString: () => "mouse" });
  const store = new InMemoryWordStore();
  const worker = {
    kick() {},
    subscribe(listener) { listener({ kind: "idle" }); return () => {}; },
  };
  const popup = new ReaderPopup({
    event: {
      doc: dom.window.document,
      params: { annotation: {} },
      append: (root) => dom.window.document.body.append(root),
    },
    store,
    captureService: new WordCaptureService({ store, lemmatizer: new IdentityLemmatizer() }),
    settings: { async read() { return { addToStudyPlan: false }; } },
    worker,
    openSettings() {},
  });

  assert.equal(popup.mount(), true);
  await settle();
  assert.equal(popup.input.value, "mouse");
  popup.dispose();
  dom.window.close();
});

test("清理观察器失败时不影响已经挂载的弹窗", async () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  dom.window.MutationObserver = class FailingMutationObserver {
    constructor() {}
    observe() { throw new TypeError("Security wrapper denied access to property 'attributeFilter'"); }
    disconnect() {}
  };
  const store = new InMemoryWordStore();
  const worker = {
    kick() {},
    subscribe() { return () => {}; },
  };
  const popup = new ReaderPopup({
    event: {
      doc: dom.window.document,
      params: { annotation: { text: "mouse" } },
      append: (root) => dom.window.document.body.append(root),
    },
    store,
    captureService: new WordCaptureService({ store, lemmatizer: new IdentityLemmatizer() }),
    settings: { async read() { return { addToStudyPlan: false }; } },
    worker,
    openSettings() {},
  });

  assert.equal(popup.mount(), true);
  assert.equal(popup.alive, true);
  assert.ok(dom.window.document.querySelector(".wordsync-maimemo-popup"));
  popup.dispose();
  dom.window.close();
});

test("词形候选并列给出，选哪个由人定；只有一种形态时不占行", async () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  const store = new InMemoryWordStore();
  const popup = new ReaderPopup({
    event: {
      doc: dom.window.document,
      params: { annotation: { text: "the attenuated signal" } },
      append: (root) => dom.window.document.body.append(root),
    },
    captureService: new WordCaptureService({ store, lemmatizer: new RuleLemmatizer() }),
    store,
    settings: { async read() { return { addToStudyPlan: true }; } },
    worker: { subscribe() { return () => {}; }, kick() {} },
  });
  popup.mount();
  await settle();

  // 选区里有多个词，先挑词；挑中的词再给词形。
  popup.selectWord("attenuated");
  await settle();
  assert.deepEqual(popup.formButtons.map((button) => button.textContent), ["attenuate", "attenuated"],
    "动词原形和分词形容词在墨墨是两个词条，都要摆出来");
  assert.equal(popup.input.value, "attenuate", "默认仍是原形，收录率最稳");
  assert.equal(popup.formButtons[0].getAttribute("aria-pressed"), "true");

  popup.formButtons[1].click();
  await settle();
  assert.equal(popup.input.value, "attenuated", "点哪个就用哪个");
  assert.equal(popup.formButtons[1].getAttribute("aria-pressed"), "true");
  assert.equal(popup.formButtons[0].getAttribute("aria-pressed"), "false");

  popup.addButton.click();
  await settle();
  assert.equal((await store.listAll())[0].lemma, "attenuated", "存的是你点的那个形态");

  // 没有第二种形态时，这一行不渲染任何按钮。
  popup.selectWord("signal");
  await settle();
  assert.deepEqual(popup.formButtons, []);
  assert.equal(popup.formRow.childNodes.length, 0);

  // 设置入口已从弹窗去掉。
  assert.equal([...popup.root.querySelectorAll("button")].some((b) => b.textContent === "设置"), false);

  popup.dispose();
  dom.window.close();
});

test("队列整个卡住时，弹窗说清楚卡在哪，而不是一直显示等待同步", async () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  const store = new InMemoryWordStore();
  let notify;
  const worker = {
    subscribe(listener) { notify = listener; listener({ kind: "idle", message: "等待加入单词" }); return () => {}; },
    kick() {},
  };
  const popup = new ReaderPopup({
    event: {
      doc: dom.window.document,
      params: { annotation: { text: "mouse" } },
      append: (root) => dom.window.document.body.append(root),
    },
    captureService: new WordCaptureService({ store, lemmatizer: new RuleLemmatizer() }),
    store,
    settings: { async read() { return { addToStudyPlan: true }; } },
    worker,
  });
  popup.mount();
  await settle();

  popup.addButton.click();
  await settle();
  assert.equal(popup.status.textContent, "已保存，后台将同步到墨墨");

  // 队列发现没选云词本后停下来，弹窗要把这句话原样透出来。
  notify({ kind: "error", message: "尚未选择云词本，请在设置中选择或新建一个" });
  await settle();
  assert.equal(popup.status.textContent, "尚未选择云词本，请在设置中选择或新建一个");

  notify({ kind: "authentication", message: "请在设置中填写墨墨 Token，单词已保存在本地" });
  await settle();
  assert.equal(popup.status.textContent, "请在设置中填写墨墨 Token，单词已保存在本地");

  popup.dispose();
  dom.window.close();
});
