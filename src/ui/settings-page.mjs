import { safeErrorMessage } from "../application/sync-error.mjs";
import { wordStatusText } from "./word-status.mjs";

export class SettingsPage {
  constructor({ root, settings, store, worker, onConfigurationChange, onDispose }) {
    this.root = root;
    this.settings = settings;
    this.store = store;
    this.worker = worker;
    this.onConfigurationChange = onConfigurationChange;
    this.onDispose = onDispose;
    this.alive = true;
    this.listeners = [];
    this.revision = 0;
  }

  query(name) { return this.root.querySelector(`[data-wordsync="${name}"]`); }

  listen(element, type, callback) {
    element.addEventListener(type, callback);
    this.listeners.push(() => element.removeEventListener(type, callback));
  }

  async mount() {
    this.token = this.query("token");
    this.studyPlan = this.query("study-plan");
    this.message = this.query("message");
    this.buttons = [...this.root.querySelectorAll("button")];
    this.listen(this.query("save"), "click", () => void this.perform(async () => {
      await this.onConfigurationChange(async () => this.settings.save({
        token: this.token.value, addToStudyPlan: this.studyPlan.checked,
      }), { resume: true });
      this.token.value = "";
      await this.populateSettings();
      this.message.textContent = "设置已保存";
    }));
    this.listen(this.query("test"), "click", () => void this.perform(async () => {
      const notepad = await this.settings.testConnection(this.token.value);
      this.message.textContent = `连接成功，已找到云词本「${notepad.title}」`;
    }));
    this.listen(this.query("clear"), "click", () => void this.perform(async () => {
      await this.onConfigurationChange(() => this.settings.clearToken(), { resume: false });
      this.token.value = "";
      await this.populateSettings();
      this.message.textContent = "Token 已清除，同步已暂停；本地单词记录已保留";
    }));
    this.listen(this.query("retry"), "click", () => void this.perform(async () => {
      await this.worker.retry();
      this.message.textContent = "已安排重试未完成的单词";
    }));
    this.listen(this.root, "unload", () => this.dispose());
    this.listen(this.root.ownerDocument.defaultView, "unload", () => this.dispose());
    this.listen(this.root, "showing", () => void this.refreshRecords());
    this.unsubscribe = this.worker.subscribe((state) => {
      if (!this.alive) return;
      this.query("worker-status").textContent = state.message;
      void this.refreshRecords();
    });
    await this.perform(async () => {
      await this.populateSettings();
      await this.refreshRecords();
    });
  }

  async populateSettings() {
    const config = await this.settings.read();
    if (!this.alive) return;
    this.studyPlan.checked = config.addToStudyPlan;
    this.token.placeholder = config.hasToken ? "已保存；留空保留当前 Token" : "粘贴墨墨开放 API Token";
    this.query("token-state").textContent = config.hasToken ? "Token 已保存" : "尚未配置 Token，可先在阅读器中保存单词";
  }

  async perform(action) {
    if (this.busy || !this.alive) return;
    this.busy = true;
    for (const button of this.buttons) button.disabled = true;
    this.token.disabled = true;
    this.studyPlan.disabled = true;
    this.message.textContent = "正在处理…";
    try {
      await action();
      if (this.alive && this.message.textContent === "正在处理…") this.message.textContent = "";
    } catch (error) {
      if (this.alive) this.message.textContent = safeErrorMessage(error);
    } finally {
      this.busy = false;
      if (this.alive) {
        for (const button of this.buttons) button.disabled = false;
        this.token.disabled = false;
        this.studyPlan.disabled = false;
      }
    }
  }

  async refreshRecords() {
    const revision = ++this.revision;
    try {
      const records = await this.store.listAll();
      if (!this.alive || revision !== this.revision) return;
      const pending = records.filter((record) => record.status !== "synced").length;
      this.query("counts").textContent = `共 ${records.length} 个单词，${pending} 个待完成`;
      const list = this.query("records");
      list.replaceChildren();
      for (const record of records.slice().reverse().slice(0, 50)) {
        const item = list.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "li");
        item.textContent = `${record.lemma} · ${wordStatusText(record)}`;
        if (record.lastError) {
          const detail = list.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "div");
          detail.className = "wordsync-record-error";
          detail.textContent = safeErrorMessage({ message: record.lastError });
          item.append(detail);
        }
        list.append(item);
      }
    } catch (error) {
      if (this.alive && revision === this.revision) this.message.textContent = safeErrorMessage(error);
    }
  }

  dispose() {
    if (!this.alive) return;
    this.alive = false;
    ++this.revision;
    this.token.value = "";
    this.unsubscribe?.();
    for (const remove of this.listeners) remove();
    this.listeners = [];
    this.onDispose?.(this);
  }
}
