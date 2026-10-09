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
    this.pending = Promise.resolve();
  }

  query(name) { return this.root.querySelector(`[data-wordsync="${name}"]`); }

  // 界面少了哪个元素要说出名字，否则抛出来的是一句看不懂的 undefined 错误。
  require(name) {
    const element = this.query(name);
    if (!element) throw new Error(`设置界面缺少元素：${name}`);
    return element;
  }

  listen(element, type, callback) {
    element.addEventListener(type, callback);
    this.listeners.push(() => element.removeEventListener(type, callback));
  }

  async mount() {
    this.token = this.require("token");
    this.studyPlan = this.require("study-plan");
    this.message = this.require("message");
    this.notepadList = this.require("notepad-list");
    this.notepadTitle = this.require("notepad-new-title");
    this.chosenMark = this.require("notepad-chosen");
    this.testButton = this.require("test");
    this.testResult = this.require("test-result");
    this.controls = [...this.root.querySelectorAll("button, input, select")];
    this.notepadTitle.placeholder = DEFAULT_MAIMEMO_NOTEPAD_TITLE;
    this.listen(this.notepadList, "change", () => void this.markChosen());
    this.listen(this.require("notepad-select"), "click", () => void this.perform(async () => {
      const option = this.notepadList.selectedOptions?.[0];
      if (!option?.value) throw new Error("请先查询并选择一个云词本");
      await this.onConfigurationChange(
        () => this.settings.selectNotepad({ id: option.value, title: option.textContent }),
        { resume: true },
      );
      await this.populateSettings();
      await this.markChosen();
      this.message.textContent = `已改用云词本「${option.textContent}」`;
    }));
    this.listen(this.require("notepad-create"), "click", () => void this.perform(async () => {
      const title = this.notepadTitle.value.trim() || DEFAULT_MAIMEMO_NOTEPAD_TITLE;
      const notepad = await this.settings.createNotepad({ title }, this.token.value);
      if (!this.alive) return;
      this.notepadTitle.value = "";
      // 只是建好了，还没开始用。刷新列表并把它选上，点一次「使用所选词本」才换。
      await this.loadNotepads();
      if (!this.alive) return;
      this.notepadList.value = notepad.id;
      await this.markChosen();
      this.message.textContent = `已新建云词本「${notepad.title}」，点「使用所选词本」开始用它`;
    }));
    // 没有「保存设置」按钮，改完就存。Token 用 change 而不是 input，
    // 免得每敲一个字符都去写一次凭据库。
    this.listen(this.token, "change", () => void this.perform(async () => {
      await this.saveSettings();
      this.message.textContent = this.token.value.trim() ? "Token 已保存" : "Token 未改动";
    }, { lock: false }));
    this.listen(this.token, "input", () => this.setTestResult(null));
    this.listen(this.studyPlan, "change", () => void this.perform(async () => {
      await this.saveSettings();
      this.message.textContent = this.studyPlan.checked ? "已开启自动加入学习计划" : "已关闭自动加入学习计划";
    }, { lock: false }));
    this.listen(this.testButton, "click", () => void this.perform(async () => {
      this.message.textContent = "";
      let notepads;
      try {
        notepads = await this.settings.testConnection(this.token.value);
      } catch (error) {
        this.setTestResult(false, safeErrorMessage(error));
        return;
      }
      this.setTestResult(true, "连接成功！");
      // 测试连接返回的就是列表，直接用，不再多发一次请求。
      await this.loadNotepads(notepads);
    }));
    this.listen(this.require("clear"), "click", () => void this.perform(async () => {
      await this.onConfigurationChange(() => this.settings.clearToken(), { resume: false });
      this.token.value = "";
      this.setTestResult(null);
      await this.populateSettings();
      this.message.textContent = "Token 已清除，同步已暂停；本地单词记录已保留";
    }));
    this.listen(this.require("retry"), "click", () => void this.perform(async () => {
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
      // 没有「查询云词本」按钮了，有 Token 就自己把列表拉下来。
      // 拉不动不该连累整个设置页，错误落到提示行即可。
      try {
        if ((await this.settings.read()).hasToken) await this.loadNotepads();
        else await this.showSavedNotepad();
      } catch (error) {
        // 拉不动就退回本地记着的那个，否则删掉「当前词本」那行之后，
        // 离线或 Token 失效时完全看不出在用哪个词本。
        await this.showSavedNotepad();
        if (this.alive) this.message.textContent = safeErrorMessage(error);
      }
    });
  }

  async populateSettings() {
    const config = await this.settings.read();
    if (!this.alive) return;
    this.studyPlan.checked = config.addToStudyPlan;
    this.token.placeholder = "粘贴墨墨开放 API Token";
    // 正在输入时不要把光标下的内容换掉。
    if (this.token !== this.root.ownerDocument.activeElement) this.token.value = config.token ?? "";
  }

  /**
   * 串行执行，不丢动作。
   *
   * 原来忙时直接 return，于是「填完 Token 直接点测试连接」会失效：点击让输入框
   * 失焦、触发自动保存，保存把界面锁住，紧接着那一下点击就被吃掉了。现在排队。
   * lock 为 false 的动作（自动保存）不锁界面，按钮仍可点，点击排在它后面执行。
   */
  perform(action, { lock = true } = {}) {
    const run = async () => {
      if (!this.alive) return;
      if (lock) {
        for (const control of this.controls) control.disabled = true;
        this.message.textContent = "正在处理…";
      }
      try {
        await action();
        if (this.alive && this.message.textContent === "正在处理…") this.message.textContent = "";
      } catch (error) {
        if (this.alive) this.message.textContent = safeErrorMessage(error);
      } finally {
        if (lock && this.alive) {
          for (const control of this.controls) control.disabled = false;
        }
      }
    };
    this.pending = this.pending.then(run, run);
    return this.pending;
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

  async loadNotepads(prefetched) {
    const notepads = prefetched ?? await this.settings.listNotepads(this.token.value);
    if (!this.alive) return 0;
    this.fillNotepads(notepads);
    // 已选中的词本在列表里保持选中，避免「使用所选词本」误选到第一个。
    const config = await this.settings.read();
    if (this.alive && config.notepad && notepads.some((item) => item.id === config.notepad.id)) {
      this.notepadList.value = config.notepad.id;
    }
    await this.markChosen();
    return notepads.length;
  }

  /** 列表拉不下来时的兜底：把本地存着的词本摆进去，至少看得出在用哪个。 */
  async showSavedNotepad() {
    const config = await this.settings.read();
    if (!this.alive || !config.notepad) return;
    this.fillNotepads([config.notepad]);
    this.notepadList.value = config.notepad.id;
    await this.markChosen();
  }

  /** 列表里选中的就是正在用的那个词本时，底色变绿并标出「已选择」。 */
  async markChosen() {
    const config = await this.settings.read();
    if (!this.alive) return;
    const chosen = Boolean(config.notepad) && this.notepadList.value === config.notepad.id;
    this.notepadList.classList.toggle("wordsync-chosen", chosen);
    this.chosenMark.hidden = !chosen;
  }

  saveSettings() {
    return this.onConfigurationChange(
      () => this.settings.save({ token: this.token.value, addToStudyPlan: this.studyPlan.checked }),
      { resume: true },
    );
  }

  // 按钮本身不变色，结果写在下面那行小字里：通了绿字，没通红字写原因。
  setTestResult(ok, text = "") {
    if (!this.testResult) return;
    this.testResult.textContent = text;
    this.testResult.classList.toggle("wordsync-test-ok", ok === true);
    this.testResult.classList.toggle("wordsync-test-bad", ok === false);
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
    this.unsubscribe?.();
    for (const remove of this.listeners) remove();
    this.listeners = [];
    this.onDispose?.(this);
  }
}
