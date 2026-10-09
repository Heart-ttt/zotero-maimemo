export const WordSyncStatus = Object.freeze({
  QUEUED: "queued",
  PARTIAL: "partial",
  SYNCED: "synced",
  FAILED: "failed",
});

export function normalizeLemma(value) {
  if (typeof value !== "string") {
    throw new TypeError("lemma must be a string");
  }

  const normalized = value.normalize("NFKC").replaceAll("’", "'").trim().toLocaleLowerCase("en-US");
  if (!normalized || !/^[\p{L}][\p{L}'-]*$/u.test(normalized)) {
    throw new Error(`invalid lemma: ${value}`);
  }
  return normalized;
}

export function normalizeSurface(value) {
  if (typeof value !== "string") {
    throw new TypeError("surface must be a string");
  }

  const normalized = value.normalize("NFKC").trim();
  if (!/^[\p{L}]+(?:['’-][\p{L}]+)*$/u.test(normalized)) {
    throw new Error("surface must be one word");
  }
  return normalized;
}

export function createWordRecord({
  id = createRecordId(),
  lemma,
  surface,
  notepadId = null,
  addToStudyPlan = true,
  createdAt = new Date().toISOString(),
}) {
  const normalizedLemma = normalizeLemma(lemma);
  const normalizedSurface = normalizeSurface(surface);
  return {
    id,
    lemma: normalizedLemma,
    surface: normalizedSurface,
    notepadId,
    addToStudyPlan: Boolean(addToStudyPlan),
    inNotepad: false,
    inStudyPlan: false,
    notepadAddedByPlugin: false,
    status: WordSyncStatus.QUEUED,
    lastError: null,
    lastErrorKind: null,
    retryable: true,
    createdAt,
    updatedAt: createdAt,
  };
}

function createRecordId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `word-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function updateWordRecord(record, changes, updatedAt = new Date().toISOString()) {
  return {
    ...record,
    ...changes,
    updatedAt,
  };
}
