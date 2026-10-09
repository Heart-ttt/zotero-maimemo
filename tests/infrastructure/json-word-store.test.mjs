import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JsonWordStore } from "../../src/infrastructure/json-word-store.mjs";
import { WordCaptureService } from "../../src/application/word-capture-service.mjs";
import { IdentityLemmatizer } from "../../src/domain/lemmatizer.mjs";
import { createWordRecord } from "../../src/domain/word-record.mjs";

test("持久化记录重启恢复，并发加入同一原形只保存一条", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "wordsync-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "words.json");
  const file = {
    async read() { try { return await readFile(target, "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; } },
    async writeAtomic(text) { await writeFile(target + ".tmp", text); await rename(target + ".tmp", target); },
  };
  const store = new JsonWordStore({ file });
  const capture = new WordCaptureService({ store, lemmatizer: new IdentityLemmatizer() });
  const input = { selectionText: "mice and mouse", selectedSurface: "mice", lemma: "mouse" };
  const results = await Promise.all([capture.addFromSelection(input), capture.addFromSelection(input)]);
  assert.deepEqual(results.map((result) => result.kind).sort(), ["duplicate", "queued"]);
  const record = (await store.listAll())[0];
  await store.update({ ...record, status: "partial", inNotepad: true });
  const restored = new JsonWordStore({ file });
  assert.equal((await restored.get(record.id)).inNotepad, true);
  assert.equal((await restored.listPending()).length, 1);
  assert.equal((await readFile(target, "utf8")).includes("mice and mouse"), false);
});

test("损坏文件不覆盖，写入失败不提交内存，后续仍可重试", async () => {
  let content = "{broken";
  let writes = 0;
  const corrupt = new JsonWordStore({ file: { async read() { return content; }, async writeAtomic() { writes++; } } });
  await assert.rejects(corrupt.listAll(), /原文件已保留/);
  await assert.rejects(corrupt.insert(createWordRecord({ lemma: "mouse", surface: "mice" })), /原文件已保留/);
  assert.equal(writes, 0);
  content = null;
  let fail = true;
  const store = new JsonWordStore({ file: {
    async read() { return content; },
    async writeAtomic(text) { if (fail) throw new Error("disk full"); content = text; },
  } });
  const record = createWordRecord({ lemma: "mouse", surface: "mice" });
  await assert.rejects(store.insert(record), /disk full/);
  assert.deepEqual(await store.listAll(), []);
  fail = false;
  await store.insert(record);
  assert.equal((await store.listAll()).length, 1);
});

function fakeFile(initial = null) {
  const state = { content: initial, appends: 0, rewrites: 0 };
  return {
    state,
    async read() { return state.content; },
    async writeAtomic(text) { state.rewrites += 1; state.content = text; },
    async append(text) { state.appends += 1; state.content = (state.content ?? "") + text; },
  };
}

test("改一条只追加一行，不重写整个文件；行数积多了才整理一次", async () => {
  const file = fakeFile();
  const store = new JsonWordStore({ file });
  const record = createWordRecord({ lemma: "mouse", surface: "mice" });
  await store.insert(record);
  const afterInsert = { ...file.state };

  for (let round = 0; round < 10; round += 1) {
    await store.update({ ...record, status: "partial", inNotepad: true, notepadId: `n${round}` });
  }

  assert.equal(file.state.appends, afterInsert.appends + 10, "每次改动一次追加");
  assert.equal(file.state.rewrites, afterInsert.rewrites, "期间不重写整个文件");
  assert.equal(file.state.content.trim().split("\n").length, 11, "文件里躺着 11 行");

  // 重放后只认最后一条，状态是最新的。
  const restored = new JsonWordStore({ file });
  assert.equal((await restored.listAll()).length, 1);
  assert.equal((await restored.get(record.id)).notepadId, "n9");

  // 行数积到阈值就整理一次，文件不会跟着写入次数一直涨。
  for (let round = 0; round < 60; round += 1) {
    await store.update({ ...record, status: "partial", inNotepad: true, notepadId: `m${round}` });
  }
  assert.equal(file.state.rewrites, afterInsert.rewrites + 1, "71 次写入只整理了一次");
  const lines = file.state.content.trim().split("\n").length;
  assert.ok(lines < 30, `文件保持在 ${lines} 行，没有跟着 71 次写入一起涨`);

  const compacted = new JsonWordStore({ file });
  assert.equal((await compacted.get(record.id)).notepadId, "m59", "整理前后读到的都是最新状态");
});

test("崩溃时写了一半的末行丢掉，整个文件坏掉则报错不覆盖", async () => {
  const file = fakeFile();
  const store = new JsonWordStore({ file });
  const record = createWordRecord({ lemma: "mouse", surface: "mice" });
  await store.insert(record);

  const truncated = fakeFile(file.state.content + '{"op":"put","rec');
  const recovered = new JsonWordStore({ file: truncated });
  assert.equal((await recovered.listAll()).length, 1, "前面完整的那行还在");

  const garbage = fakeFile("{broken\n{alsobroken\n");
  const broken = new JsonWordStore({ file: garbage });
  await assert.rejects(broken.listAll(), /原文件已保留/);
  assert.equal(garbage.state.rewrites, 0, "坏文件一个字节都不许写");
});

test("旧版整文件格式能读出来，并在下一次写入时自动转成追加格式", async () => {
  const legacyRecord = { ...createWordRecord({ lemma: "mouse", surface: "mice" }), notepadId: "old" };
  const file = fakeFile(JSON.stringify({ version: 1, records: [legacyRecord] }, null, 2));
  const store = new JsonWordStore({ file });

  assert.equal((await store.get(legacyRecord.id)).notepadId, "old", "旧记录要读得出来");

  await store.update({ ...legacyRecord, status: "synced" });
  assert.equal(file.state.rewrites, 1, "第一次写入顺手整理成新格式");
  assert.equal(JSON.parse(file.state.content.trim()).op, "put");

  const restored = new JsonWordStore({ file });
  assert.equal((await restored.get(legacyRecord.id)).status, "synced");
});
