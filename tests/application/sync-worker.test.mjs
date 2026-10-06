import test from "node:test";
import assert from "node:assert/strict";
import { SyncWorker } from "../../src/application/sync-worker.mjs";
import { WordSyncService } from "../../src/application/word-sync-service.mjs";
import { InMemoryWordStore } from "../../src/infrastructure/in-memory-word-store.mjs";
import { createWordRecord } from "../../src/domain/word-record.mjs";
import { MaimemoApiError } from "../../src/integrations/maimemo/maimemo-api-client.mjs";
import { ManualTimers, deferred, settle } from "../helpers/fakes.mjs";

function createWorker({ notepadGateway, studyPlanGateway, records } = {}) {
  const store = new InMemoryWordStore(records ?? [createWordRecord({ lemma: "mouse", surface: "mice" })]);
  const timers = new ManualTimers();
  const service = new WordSyncService({ store, notepadGateway: notepadGateway ?? { async addWord() {} }, studyPlanGateway: studyPlanGateway ?? { async addWords() {} } });
  const worker = new SyncWorker({ store, timers, createSession: async () => ({ notepad: { id: "target" }, syncService: service }) });
  return { worker, store, timers };
}

test("队列串行消费，重复唤醒不产生并发写入", async () => {
  const gate = deferred();
  let calls = 0;
  const { worker, store } = createWorker({ notepadGateway: { async addWord() { calls++; await gate.promise; } } });
  const first = worker.flush();
  await settle();
  const second = worker.flush();
  worker.kick();
  assert.equal(first, second);
  gate.resolve();
  await first;
  assert.equal(calls, 1);
  assert.equal((await store.listAll())[0].status, "synced");
  await worker.stop();
});

test("认证失效暂停整个队列，修复后重试恢复", async () => {
  let valid = false;
  let calls = 0;
  const records = ["mouse", "apple"].map((lemma) => createWordRecord({ lemma, surface: lemma }));
  const { worker, store, timers } = createWorker({ records, notepadGateway: { async addWord() {
    calls++;
    if (!valid) throw new MaimemoApiError("expired", { status: 401, code: "common_unauthorized" });
  } } });
  await worker.flush();
  assert.equal(worker.state.kind, "authentication");
  assert.equal(calls, 1);
  worker.kick();
  assert.equal(timers.tasks.size, 0);
  valid = true;
  await worker.retry();
  await worker.flush();
  assert.equal((await store.listPending()).length, 0);
  await worker.stop();
});

test("临时错误延迟重试，重试只补学习计划，停止后清除计时器", async () => {
  let attempts = 0;
  let wordWrites = 0;
  const { worker, store, timers } = createWorker({
    notepadGateway: { async addWord() { wordWrites++; } },
    studyPlanGateway: { async addWords() {
      if (++attempts === 1) throw new MaimemoApiError("offline", { retryable: true });
    } },
  });
  await worker.flush();
  assert.equal(worker.state.kind, "waiting");
  assert.equal((await store.listAll())[0].status, "partial");
  assert.equal([...timers.tasks.values()][0].delay, 10000);
  worker.kick();
  assert.equal(timers.tasks.size, 1);
  await worker.flush();
  assert.equal(wordWrites, 1);
  assert.equal((await store.listAll())[0].status, "synced");
  await worker.stop();
  worker.kick();
  assert.equal(timers.tasks.size, 0);
});

test("永久错误不自动循环重试，目标词本变化不复用旧进度", async () => {
  let attempts = 0;
  const record = { ...createWordRecord({ lemma: "mouse", surface: "mice", notepadId: "old" }), inNotepad: true, status: "partial" };
  const { worker, store, timers } = createWorker({ records: [record], studyPlanGateway: { async addWords() { attempts++; } } });
  await worker.flush();
  assert.equal(attempts, 0);
  assert.match((await store.listAll())[0].lastError, /目标词本已变化/);
  assert.equal(timers.tasks.size, 0);
  await worker.stop();
});
