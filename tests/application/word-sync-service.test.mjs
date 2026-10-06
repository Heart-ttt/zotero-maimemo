import test from "node:test";
import assert from "node:assert/strict";
import { WordSyncService } from "../../src/application/word-sync-service.mjs";
import { InMemoryWordStore } from "../../src/infrastructure/in-memory-word-store.mjs";
import { createWordRecord, WordSyncStatus } from "../../src/domain/word-record.mjs";

function buildRecord(overrides = {}) {
  return createWordRecord({
    id: "record-1",
    lemma: "attenuate",
    surface: "attenuated",
    notepadId: "notepad-1",
    ...overrides,
  });
}

test("sync completes cloud notepad and study plan steps in order", async () => {
  const store = new InMemoryWordStore([buildRecord()]);
  const calls = [];
  const service = new WordSyncService({
    store,
    notepadGateway: {
      async addWord(input) {
        calls.push(["notepad", input]);
      },
    },
    studyPlanGateway: {
      async addWords(input) {
        calls.push(["study", input]);
      },
    },
    clock: () => "2026-10-04T00:00:00.000Z",
  });

  const result = await service.syncRecord("record-1");

  assert.equal(result.status, WordSyncStatus.SYNCED);
  assert.equal(result.inNotepad, true);
  assert.equal(result.inStudyPlan, true);
  assert.deepEqual(calls, [
    ["notepad", { notepadId: "notepad-1", lemma: "attenuate" }],
    ["study", { spellings: ["attenuate"], advance: true }],
  ]);
});

test("study plan can be disabled without changing the notepad flow", async () => {
  const store = new InMemoryWordStore([buildRecord({ addToStudyPlan: false })]);
  let studyCalled = false;
  const service = new WordSyncService({
    store,
    notepadGateway: { async addWord() {} },
    studyPlanGateway: { async addWords() { studyCalled = true; } },
  });

  const result = await service.syncRecord("record-1");

  assert.equal(result.status, WordSyncStatus.SYNCED);
  assert.equal(result.inNotepad, true);
  assert.equal(result.inStudyPlan, false);
  assert.equal(studyCalled, false);
});

test("a study failure becomes partial and retry skips the completed notepad step", async () => {
  const store = new InMemoryWordStore([buildRecord()]);
  let studyAttempts = 0;
  let notepadCalls = 0;
  const service = new WordSyncService({
    store,
    notepadGateway: { async addWord() { notepadCalls += 1; } },
    studyPlanGateway: {
      async addWords() {
        studyAttempts += 1;
        if (studyAttempts === 1) throw new Error("temporary study outage");
      },
    },
  });

  const partial = await service.syncRecord("record-1");
  const synced = await service.syncRecord("record-1");

  assert.equal(partial.status, WordSyncStatus.PARTIAL);
  assert.equal(partial.inNotepad, true);
  assert.match(partial.lastError, /temporary study outage/);
  assert.equal(synced.status, WordSyncStatus.SYNCED);
  assert.equal(notepadCalls, 1);
  assert.equal(studyAttempts, 2);
});

test("an initial notepad failure is failed and keeps the record retryable", async () => {
  const store = new InMemoryWordStore([buildRecord()]);
  const service = new WordSyncService({
    store,
    notepadGateway: { async addWord() { throw new Error("notepad unavailable"); } },
    studyPlanGateway: { async addWords() { throw new Error("must not be called"); } },
  });

  const result = await service.syncRecord("record-1");

  assert.equal(result.status, WordSyncStatus.FAILED);
  assert.equal(result.inNotepad, false);
  assert.equal(result.inStudyPlan, false);
  assert.match(result.lastError, /notepad unavailable/);
});
