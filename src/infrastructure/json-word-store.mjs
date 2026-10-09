import { normalizeLemma, normalizeSurface, WordSyncStatus } from "../domain/word-record.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));

// 文件按行追加：一条记录一行，同一条记录后写的行覆盖先写的。
// 重放完一遍就是当前状态。行数涨到记录数的两倍多就整理一次，
// 所以单次写入是常数开销，不随已存单词数增长。
const COMPACT_SLACK = 50;

function assertValidRecord(record) {
  if (!record || typeof record.id !== "string" || !record.id
    || normalizeLemma(record.lemma) !== record.lemma
    || normalizeSurface(record.surface) !== record.surface
    || !Object.values(WordSyncStatus).includes(record.status)
    || typeof record.inNotepad !== "boolean" || typeof record.inStudyPlan !== "boolean"
    || typeof record.addToStudyPlan !== "boolean") {
    throw new Error("invalid record");
  }
}

// 文件适配器负责原子替换与追加；这里负责串行事务及重启恢复。
export class JsonWordStore {
  constructor({ file }) {
    this.file = file;
    this.records = new Map();
    this.lines = 0;
    this.needsCompaction = false;
    this.tail = Promise.resolve();
    this.ready = this.load();
  }

  async load() {
    const text = await this.file.read();
    if (text === null) return;
    try {
      const parsed = this.parse(text.trim());
      const lemmas = new Set();
      for (const record of parsed.records.values()) {
        if (lemmas.has(record.lemma)) throw new Error("duplicate lemma");
        lemmas.add(record.lemma);
      }
      this.records = parsed.records;
      this.lines = parsed.lines;
      this.needsCompaction = parsed.legacy;
    } catch {
      // 读取失败时不创建新文件，避免覆盖用户的加入记录。
      throw new Error("本地单词记录无法读取，原文件已保留；请检查数据文件后重新启用插件");
    }
  }

  parse(text) {
    if (!text) return { records: new Map(), lines: 0, legacy: false };

    // 旧格式整个文件是一个 JSON 对象，读进来后下一次写入会自动整理成新格式。
    let whole = null;
    try {
      whole = JSON.parse(text);
    } catch {
      // 不是单个 JSON 对象，那就按一行一条记录的新格式读。
    }
    if (whole && whole.version === 1 && Array.isArray(whole.records)) {
      const records = new Map();
      for (const record of whole.records) {
        assertValidRecord(record);
        if (records.has(record.id)) throw new Error("duplicate record id");
        records.set(record.id, record);
      }
      return { records, lines: records.size, legacy: true };
    }

    const rows = text.split("\n");
    const records = new Map();
    let lines = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index].trim();
      if (!row) continue;
      let entry;
      try {
        entry = JSON.parse(row);
      } catch (error) {
        // 最后一行可能是崩溃时写了一半，丢掉它即可。但前面一行有效的都没有，
        // 那就不是写了一半，是整个文件坏了，必须报错，不能当成空文件覆盖掉。
        if (index === rows.length - 1 && lines > 0) break;
        throw error;
      }
      assertValidRecord(entry?.record);
      records.set(entry.record.id, entry.record);
      lines += 1;
    }
    return { records, lines, legacy: false };
  }

  transact(operation) {
    const task = this.tail.then(async () => {
      await this.ready;
      const next = new Map([...this.records].map(([id, record]) => [id, clone(record)]));
      const { changed, result, touched = [] } = operation(next);
      if (changed) {
        await this.persist(next, touched);
        this.records = next;
      }
      return clone(result);
    });
    // 单次落盘失败不会阻塞后续事务，失败事务也不会提交到内存。
    this.tail = task.catch(() => {});
    return task;
  }

  async persist(records, touched) {
    const canAppend = typeof this.file.append === "function";
    const tooManyLines = this.lines + touched.length > records.size * 2 + COMPACT_SLACK;
    if (!canAppend || this.needsCompaction || tooManyLines) {
      await this.file.writeAtomic(this.serialize([...records.values()]));
      this.lines = records.size;
      this.needsCompaction = false;
      return;
    }
    await this.file.append(this.serialize(touched));
    this.lines += touched.length;
  }

  serialize(records) {
    return records.map((record) => `${JSON.stringify({ op: "put", record })}\n`).join("");
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
      const stored = clone(record);
      records.set(record.id, stored);
      return { changed: true, result: { inserted: true, record }, touched: [stored] };
    });
  }

  update(record) {
    return this.transact((records) => {
      if (!records.has(record.id)) throw new Error(`word record not found: ${record.id}`);
      const stored = clone(record);
      records.set(record.id, stored);
      return { changed: true, result: record, touched: [stored] };
    });
  }

  async listAll() {
    await this.ready;
    await this.tail;
    return clone([...this.records.values()]);
  }

  async get(id) {
    await this.ready;
    await this.tail;
    const record = this.records.get(id);
    return record ? clone(record) : null;
  }

  async findByLemma(lemma) {
    await this.ready;
    await this.tail;
    for (const record of this.records.values()) {
      if (record.lemma === lemma) return clone(record);
    }
    return null;
  }

  async listPending() {
    await this.ready;
    await this.tail;
    const pending = [];
    for (const record of this.records.values()) {
      if (record.status !== WordSyncStatus.SYNCED) pending.push(clone(record));
    }
    return pending;
  }
}
