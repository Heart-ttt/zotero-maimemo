import { WordSyncStatus, updateWordRecord } from "../domain/word-record.mjs";
import { classifySyncError, safeErrorMessage } from "./sync-error.mjs";

export class WordSyncService {
  constructor({
    store,
    notepadGateway,
    studyPlanGateway,
    canSync = () => true,
    clock = () => new Date().toISOString(),
  }) {
    this.store = store;
    this.notepadGateway = notepadGateway;
    this.studyPlanGateway = studyPlanGateway;
    this.clock = clock;
    this.canSync = canSync;
  }

  async syncRecord(recordId) {
    let record = await this.store.get(recordId);
    if (!record) {
      throw new Error(`word record not found: ${recordId}`);
    }

    try {
      this.assertActive();
      if (!record.inNotepad) {
        if (!record.notepadId) {
          throw new Error("notepadId is required before synchronization");
        }
        const result = await this.notepadGateway.addWord({
          notepadId: record.notepadId,
          lemma: record.lemma,
        });
        record = await this.save(record, {
          inNotepad: true,
          notepadAddedByPlugin: result?.added === true,
        });
      }

      if (record.addToStudyPlan && !record.inStudyPlan) {
        this.assertActive();
        await this.studyPlanGateway.addWords({
          spellings: [record.lemma],
          advance: true,
        });
        record = await this.save(record, { inStudyPlan: true });
      }

      return this.save(record, {
        status: WordSyncStatus.SYNCED,
        lastError: null,
        lastErrorKind: null,
        retryable: false,
      });
    } catch (error) {
      const hasCompletedStep = record.inNotepad;
      const status = hasCompletedStep ? WordSyncStatus.PARTIAL : WordSyncStatus.FAILED;
      return this.save(record, {
        status,
        lastError: safeErrorMessage(error),
        lastErrorKind: classifySyncError(error),
        retryable: error?.retryable === true,
      });
    }
  }

  async syncPending() {
    const records = await this.store.listPending();
    const results = [];
    for (const record of records) {
      results.push(await this.syncRecord(record.id));
    }
    return results;
  }

  async save(record, changes) {
    const updated = updateWordRecord(record, changes, this.clock());
    await this.store.update(updated);
    return updated;
  }

  assertActive() {
    if (!this.canSync()) {
      throw Object.assign(new Error("同步已暂停，未完成步骤已保留"), { retryable: true });
    }
  }
}
