import { MaimemoApiError } from "../maimemo/maimemo-api-client.mjs";

export class ZoteroHttpTransport {
  constructor({ Zotero }) {
    this.http = Zotero.HTTP;
    this.closed = false;
    this.cancellers = new Set();
  }

  fetch = async (url, options) => {
    if (this.closed) throw new Error("同步已停止");
    let cancel;
    try {
      const response = await this.http.request(options.method, String(url), {
        headers: options.headers,
        body: options.body,
        responseType: "text",
        successCodes: false,
        errorDelayMax: 0,
        timeout: 30000,
        // Zotero 会输出请求体到调试日志，关闭这类输出。
        debug: false,
        logBodyLength: 0,
        cancellerReceiver: (callback) => {
          cancel = callback;
          this.cancellers.add(callback);
          if (this.closed) callback();
        },
      });
      return {
        status: response.status,
        ok: response.status >= 200 && response.status < 300,
        async json() { return JSON.parse(response.responseText); },
      };
    } catch {
      // 不透传原生 HTTP 异常，避免携带请求头与凭据。
      throw new MaimemoApiError("无法连接墨墨，请检查网络后重试", { retryable: true });
    } finally {
      if (cancel) this.cancellers.delete(cancel);
    }
  };

  dispose() {
    this.closed = true;
    this.cancelPending();
  }

  cancelPending() {
    for (const cancel of this.cancellers) {
      try { cancel(); } catch { /* 请求可能已完成。 */ }
    }
    this.cancellers.clear();
  }
}
