import { assertSelectedWord } from "../domain/selection.mjs";
import { createWordRecord, normalizeLemma } from "../domain/word-record.mjs";

export class WordCaptureService {
  constructor({ store, lemmatizer, defaultNotepadId = null }) {
    this.store = store;
    this.lemmatizer = lemmatizer;
    this.defaultNotepadId = defaultNotepadId;
  }

  async addFromSelection({
    selectionText,
    selectedSurface,
    lemma: editedLemma,
    notepadId = this.defaultNotepadId,
    addToStudyPlan = true,
  }) {
    const surface = assertSelectedWord(selectionText, selectedSurface);
    // 原文中的词用于校验选区；用户修改的原形用于判重和同步。
    const lemma = normalizeLemma(editedLemma ?? await this.lemmatizer.lemmatize(surface));
    const existing = await this.store.findByLemma(lemma);

    if (existing) {
      return { kind: "duplicate", record: existing };
    }

    const record = createWordRecord({
      lemma,
      surface,
      notepadId,
      addToStudyPlan,
    });
    const result = await this.store.insertIfAbsent(record);
    return { kind: result.inserted ? "queued" : "duplicate", record: result.record };
  }
}
