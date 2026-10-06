export class MaimemoApiError extends Error {
  constructor(message, { status = 0, code = null, retryable = false } = {}) {
    super(message);
    this.name = "MaimemoApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export class MaimemoApiClient {
  constructor({ token, fetchImpl = globalThis.fetch, baseUrl = "https://open.maimemo.com/open" }) {
    if (!token || typeof token !== "string") {
      throw new Error("Maimemo token is required");
    }
    if (typeof fetchImpl !== "function") {
      throw new Error("fetchImpl is required");
    }
    this.token = token.trim();
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  // 使用已验证可用的分页大小；不假定服务端允许更大的值。
  async listNotepads({ limit = 10, offset = 0 } = {}) {
    return this.request("GET", "/api/v1/memo/notepads", { query: { limit, offset } });
  }

  async getNotepad(notepadId) {
    return this.request("GET", `/api/v1/memo/notepads/${encodeURIComponent(notepadId)}`);
  }

  async updateNotepad(notepadId, notepad) {
    return this.request("POST", `/api/v1/memo/notepads/${encodeURIComponent(notepadId)}`, {
      body: { id: notepadId, notepad },
    });
  }

  async queryVocabulary(spellings) {
    return this.request("POST", "/api/v1/memo/vocabulary/query", { body: { spellings } });
  }

  async queryStudyRecords(vocIds) {
    return this.request("POST", "/api/v1/memo/study/query_study_records", {
      body: { voc_ids: vocIds, limit: vocIds.length },
    });
  }

  async addWordsToStudyPlan(vocIds, { advance = true } = {}) {
    return this.request("POST", "/api/v1/memo/study/add_words", {
      body: { words: vocIds.map((id) => ({ id })), advance },
    });
  }

  async request(method, path, { query = {}, body } = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }

    const response = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new MaimemoApiError("墨墨返回了非 JSON 响应", {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    if (!response.ok || payload?.success !== true) {
      const firstError = payload?.errors?.[0] ?? {};
      const message = String(firstError.msg || `墨墨请求失败（HTTP ${response.status}）`)
        .replaceAll(this.token, "[redacted]");
      throw new MaimemoApiError(message, {
        status: response.status,
        code: firstError.code || null,
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    return payload.data;
  }
}
