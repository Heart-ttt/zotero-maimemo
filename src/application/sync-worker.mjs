import { classifySyncError, safeErrorMessage } from "./sync-error.mjs";
import { updateWordRecord } from "../domain/word-record.mjs";

export class SyncWorker {
  constructor({ store, createSession, timers = globalThis, retryDelay = 10000 }) {
    this.store = store;
    this.createSession = createSession;
    this.timers = timers;
    this.retryDelay = retryDelay;
    this.failures = 0;
    this.state = { kind: "idle", message: "等待加入单词" };
    this.listeners = new Set();
    this.stopped = false;
    this.running = null;
    this.timer = null;
    this.requested = false;
    this.generation = 0;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  setState(kind, message) {
    if (this.stopped && kind !== "stopped") return;
    this.state = { kind, message };
    for (const listener of this.listeners) listener(this.state);
  }

  kick() {
    if (this.stopped || this.state.kind === "authentication") return;
    this.requested = true;
    if (this.running || this.timer !== null) return;
    this.schedule(0);
  }

  schedule(delay) {
    if (this.stopped || this.timer !== null) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  flush() {
    if (this.stopped || this.state.kind === "authentication") return Promise.resolve();
    if (this.running) return this.running;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.running = this.drain().finally(() => { this.running = null; });
    return this.running;
  }

  async drain() {
    const generation = this.generation;
    try {
      do {
        this.requested = false;
        const records = (await this.store.listPending()).filter((record) =>
          record.status === "queued" || record.retryable || record.lastErrorKind === "authentication");
        if (this.stopped || generation !== this.generation) return;
        if (!records.length) break;
        this.setState("syncing", "正在同步到墨墨");
        const session = await this.createSession();
        if (this.stopped || generation !== this.generation) return;
        if (!session) {
          this.setState("authentication", "请在设置中填写墨墨 Token，单词已保存在本地");
          return;
        }
        for (let record of records) {
          if (this.stopped || generation !== this.generation) return;
          // 更换账号或词本后，不把原账号已完成的一半视作新账号的成功。
          if (record.inNotepad && record.notepadId !== session.notepad.id) {
            await this.store.update(updateWordRecord(record, {
              status: "partial", retryable: false, lastErrorKind: "permanent",
              lastError: "目标词本已变化；此记录保留原有进度，请核对原账号",
            }));
            continue;
          }
          if (!record.inNotepad && record.notepadId !== session.notepad.id) {
            record = updateWordRecord(record, { notepadId: session.notepad.id });
            await this.store.update(record);
          }
          const result = await session.syncService.syncRecord(record.id);
          if (this.stopped || generation !== this.generation) return;
          if (result.lastErrorKind === "authentication") {
            this.setState("authentication", "墨墨认证失效，请重新填写 Token；队列已暂停");
            return;
          }
          if (result.retryable) {
            this.deferRetry(result.lastErrorKind === "rate-limit"
              ? "墨墨请求过于频繁，稍后自动重试" : "暂时无法连接墨墨，稍后自动重试");
            return;
          }
          this.setState("syncing", "正在同步到墨墨");
        }
      } while (this.requested && !this.stopped);
      this.failures = 0;
      const pending = await this.store.listPending();
      if (this.stopped || generation !== this.generation) return;
      this.setState("idle", pending.length ? "部分单词未完成，请查看记录后重试" : "队列已同步完成");
    } catch (error) {
      if (this.stopped || generation !== this.generation) return;
      const kind = classifySyncError(error);
      if (kind === "authentication") {
        this.setState("authentication", "墨墨认证失效，请重新填写 Token；队列已暂停");
      } else if (error?.retryable) {
        this.deferRetry(kind === "rate-limit" ? "墨墨请求过于频繁，稍后自动重试" : "暂时无法连接墨墨，稍后自动重试");
      } else {
        this.setState("error", safeErrorMessage(error));
      }
    }
  }

  deferRetry(message) {
    const delay = Math.min(this.retryDelay * 2 ** this.failures++, 15 * 60 * 1000);
    this.setState("waiting", message);
    this.schedule(delay);
  }

  async retry() {
    if (this.stopped) return;
    // 等待当前同步完成，防止重置掉刚写入的步骤状态。
    await this.running;
    if (this.stopped) return;
    for (const record of await this.store.listPending()) {
      await this.store.update(updateWordRecord(record, { retryable: true }));
    }
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.failures = 0;
    this.setState("idle", "准备重试");
    this.kick();
  }

  async stop() {
    this.stopped = true;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.setState("stopped", "同步已停止");
    await this.running;
    this.listeners.clear();
  }

  pauseAuthentication(message = "同步已暂停，请配置墨墨 Token") {
    this.generation += 1;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.setState("authentication", message);
  }
}
