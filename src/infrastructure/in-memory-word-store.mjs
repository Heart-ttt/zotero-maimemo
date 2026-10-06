export class InMemoryWordStore {
  constructor(initialRecords = []) {
    this.records = new Map(initialRecords.map((record) => [record.id, structuredClone(record)]));
  }

  async insert(record) {
    const result = await this.insertIfAbsent(record);
    if (!result.inserted) {
      throw new Error(`duplicate lemma: ${record.lemma}`);
    }
    return result.record;
  }

  async insertIfAbsent(record) {
    const existing = [...this.records.values()].find((entry) => entry.lemma === record.lemma);
    if (existing) return { inserted: false, record: structuredClone(existing) };
    this.records.set(record.id, structuredClone(record));
    return { inserted: true, record: structuredClone(record) };
  }

  async get(id) {
    const record = this.records.get(id);
    return record ? structuredClone(record) : null;
  }

  async findByLemma(lemma) {
    const record = [...this.records.values()].find((candidate) => candidate.lemma === lemma);
    return record ? structuredClone(record) : null;
  }

  async update(record) {
    if (!this.records.has(record.id)) {
      throw new Error(`word record not found: ${record.id}`);
    }
    this.records.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async listPending() {
    return [...this.records.values()]
      .filter((record) => record.status !== "synced")
      .map((record) => structuredClone(record));
  }

  async listAll() {
    return [...this.records.values()].map((record) => structuredClone(record));
  }
}
