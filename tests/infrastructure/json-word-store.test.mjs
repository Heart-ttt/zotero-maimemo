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
