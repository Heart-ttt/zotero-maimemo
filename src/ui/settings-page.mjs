import { safeErrorMessage } from "../application/sync-error.mjs";
import { DEFAULT_MAIMEMO_NOTEPAD_TITLE } from "../application/settings-service.mjs";
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
    this.notepadList = this.query("notepad-list");
    this.notepadTitle = this.query("notepad-new-title");
    this.controls = [...this.root.querySelectorAll("button, input, select")];
    this.notepadTitle.placeholder = DEFAULT_MAIMEMO_NOTEPAD_TITLE;
    this.listen(this.query("notepad-refresh"), "click", () => void this.perform(async () => {
      const notepads = await this.settings.listNotepads(this.token.value);
      if (!this.alive) return;
      this.fillNotepads(notepads);
      this.message.textContent = notepads.length
        ? `查到 ${notepads.length} 个云词本，选一个后点「使用所选」`
        : "这个账号还没有云词本，在下面新建一个";
    }));
    this.listen(this.query("notepad-select"), "click", () => void this.perform(async () => {
      const option = this.notepadList.selectedOptions?.[0];
      if (!option?.value) throw new Error("请先查询并选择一个云词本");
      await this.onConfigurationChange(
        () => this.settings.selectNotepad({ id: option.value, title: option.textContent }),
        { resume: true },
      );
      await this.populateSettings();
      this.message.textContent = `已改用云词本「${option.textContent}」`;
    }));
    this.listen(this.query("notepad-create"), "click", () => void this.perform(async () => {
      const title = this.notepadTitle.value.trim() || DEFAULT_MAIMEMO_NOTEPAD_TITLE;
      const notepad = await this.onConfigurationChange(
        () => this.settings.createNotepad({ title }, this.token.value),
        { resume: true },
      );
      if (!this.alive) return;
      this.notepadTitle.value = "";
      await this.populateSettings();
      this.message.textContent = `已新建并改用云词本「${notepad.notepad?.title ?? title}」`;
    }));
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
      this.message.textContent = `连接成功，当前云词本「${notepad.title}」`;
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
    this.query("notepad-state").textContent = config.notepad
      ? `当前词本：${config.notepad.title}`
      : "尚未选择云词本，同步不会开始";
  }

  async perform(action) {
    if (this.busy || !this.alive) return;
    this.busy = true;
    for (const control of this.controls) control.disabled = true;
    this.message.textContent = "正在处理…";
    try {
      await action();
      if (this.alive && this.message.textContent === "正在处理…") this.message.textContent = "";
    } catch (error) {
      if (this.alive) this.message.textContent = safeErrorMessage(error);
    } finally {
      this.busy = false;
      if (this.alive) {
        for (const control of this.controls) control.disabled = false;
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

  fillNotepads(notepads) {
    const document = this.notepadList.ownerDocument;
    this.notepadList.replaceChildren();
    for (const notepad of notepads) {
      const option = document.createElementNS("http://www.w3.org/1999/xhtml", "option");
      option.value = notepad.id;
      option.textContent = notepad.title;
      this.notepadList.append(option);
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
