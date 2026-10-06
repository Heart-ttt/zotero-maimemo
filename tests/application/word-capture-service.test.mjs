import test from "node:test";
import assert from "node:assert/strict";
import { WordCaptureService } from "../../src/application/word-capture-service.mjs";
import { InMemoryWordStore } from "../../src/infrastructure/in-memory-word-store.mjs";

const lowerCaseLemmatizer = {
  async lemmatize(surface) {
    return surface.toLocaleLowerCase("en-US") === "mice" ? "mouse" : surface;
  },
};

test("capture writes one queued word and does not persist the full selection", async () => {
  const store = new InMemoryWordStore();
  const service = new WordCaptureService({
    store,
    lemmatizer: lowerCaseLemmatizer,
    defaultNotepadId: "notepad-1",
  });

  const result = await service.addFromSelection({
    selectionText: "The mice were measured.",
    selectedSurface: "mice",
  });

  assert.equal(result.kind, "queued");
  assert.equal(result.record.lemma, "mouse");
  assert.equal(result.record.surface, "mice");
  assert.equal(result.record.notepadId, "notepad-1");
  assert.equal("selectionText" in result.record, false);
  assert.equal((await store.listAll()).length, 1);
});

test("capture returns duplicate when another surface resolves to the same lemma", async () => {
  const store = new InMemoryWordStore();
  const service = new WordCaptureService({
    store,
    lemmatizer: lowerCaseLemmatizer,
    defaultNotepadId: "notepad-1",
  });

  await service.addFromSelection({
    selectionText: "The mice were measured.",
    selectedSurface: "mice",
  });
  const duplicate = await service.addFromSelection({
    selectionText: "One mouse was measured.",
    selectedSurface: "mouse",
  });

  assert.equal(duplicate.kind, "duplicate");
  assert.equal((await store.listAll()).length, 1);
});
