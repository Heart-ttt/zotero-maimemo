import { normalizeLemma, normalizeSurface, WordSyncStatus } from "../domain/word-record.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));

// 文件适配器负责原子替换；这里负责串行事务及重启恢复。
export class JsonWordStore {
  constructor({ file }) {
    this.file = file;
    this.records = new Map();
    this.tail = Promise.resolve();
    this.ready = this.load();
  }

  async load() {
    const text = await this.file.read();
    if (text === null) return;
    let snapshot;
    try {
      snapshot = JSON.parse(text);
      if (snapshot.version !== 1 || !Array.isArray(snapshot.records)) throw new Error();
      const ids = new Set();
      const lemmas = new Set();
      for (const record of snapshot.records) {
        if (!record.id || ids.has(record.id) || lemmas.has(record.lemma)
          || normalizeLemma(record.lemma) !== record.lemma
          || normalizeSurface(record.surface) !== record.surface
          || !Object.values(WordSyncStatus).includes(record.status)
          || typeof record.inNotepad !== "boolean" || typeof record.inStudyPlan !== "boolean"
          || typeof record.addToStudyPlan !== "boolean") throw new Error();
        ids.add(record.id);
        lemmas.add(record.lemma);
      }
    } catch {
      // 读取失败时不创建新文件，避免覆盖用户的加入记录。
      throw new Error("本地单词记录无法读取，原文件已保留；请检查数据文件后重新启用插件");
    }
    this.records = new Map(snapshot.records.map((record) => [record.id, record]));
  }

  transact(operation) {
    const task = this.tail.then(async () => {
      await this.ready;
      const next = new Map([...this.records].map(([id, record]) => [id, clone(record)]));
      const { changed, result } = operation(next);
      if (changed) {
        await this.file.writeAtomic(JSON.stringify({ version: 1, records: [...next.values()] }, null, 2));
        this.records = next;
      }
      return clone(result);
    });
    // 单次落盘失败不会阻塞后续事务，失败事务也不会提交到内存。
    this.tail = task.catch(() => {});
    return task;
  }

  async insert(record) {
    const result = await this.insertIfAbsent(record);
    if (!result.inserted) throw new Error(`duplicate lemma: ${record.lemma}`);
    return result.record;
  }

  insertIfAbsent(record) {
    return this.transact((records) => {
      const existing = [...records.values()].find((entry) => entry.lemma === record.lemma);
      if (existing) return { changed: false, result: { inserted: false, record: existing } };
      if (records.has(record.id)) throw new Error("duplicate record id");
      records.set(record.id, clone(record));
      return { changed: true, result: { inserted: true, record } };
    });
  }

  update(record) {
    return this.transact((records) => {
      if (!records.has(record.id)) throw new Error(`word record not found: ${record.id}`);
      records.set(record.id, clone(record));
      return { changed: true, result: record };
    });
  }

  async listAll() {
    await this.ready;
    await this.tail;
    return clone([...this.records.values()]);
  }

  async get(id) {
    return (await this.listAll()).find((record) => record.id === id) ?? null;
  }

  async findByLemma(lemma) {
    return (await this.listAll()).find((record) => record.lemma === lemma) ?? null;
  }

  async listPending() {
    return (await this.listAll()).filter((record) => record.status !== WordSyncStatus.SYNCED);
  }
}
