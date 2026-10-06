import test from "node:test";
import assert from "node:assert/strict";
import {
  WordSyncStatus,
  createWordRecord,
  normalizeLemma,
} from "../../src/domain/word-record.mjs";

test("createWordRecord stores only word metadata and starts queued", () => {
  const record = createWordRecord({
    id: "record-1",
    lemma: "MICE",
    surface: "mice",
    notepadId: "notepad-1",
  });

  assert.equal(record.id, "record-1");
  assert.equal(record.lemma, "mice");
  assert.equal(record.surface, "mice");
  assert.equal(record.notepadId, "notepad-1");
  assert.equal(record.status, WordSyncStatus.QUEUED);
  assert.equal(record.inNotepad, false);
  assert.equal(record.inStudyPlan, false);
  assert.equal("sentence" in record, false);
  assert.equal("phraseId" in record, false);
});

test("normalizeLemma rejects whitespace-separated selections", () => {
  assert.throws(() => normalizeLemma("two words"), /invalid lemma/);
});
