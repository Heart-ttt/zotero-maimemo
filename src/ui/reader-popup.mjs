import { extractWordCandidates } from "../domain/selection.mjs";
import { lemmaChoices } from "../domain/lemmatizer.mjs";
import { normalizeLemma } from "../domain/word-record.mjs";
import { safeErrorMessage } from "../application/sync-error.mjs";
import { wordStatusText } from "./word-status.mjs";

// 弹窗挂在 Zotero 原生的选中弹窗里，样式只作用于自己这一块。
// 放在这里而不是 mount() 里，mount 才看得出它在搭什么结构。
// Zotero 给每个插件区块套了 .section，自带上分隔线和上下内边距，
// 这里不再画线、不留底边距，否则会叠出两条线和一截空白。
const POPUP_STYLE = `
      .wordsync-maimemo-popup { padding: 7px 8px 0;
        width: 248px; max-width: 100%; box-sizing: border-box; font: 12px/1.45 system-ui; color: inherit; }
      .wordsync-maimemo-popup .wordsync-row { display: flex; align-items: center; gap: 4px;
        flex-wrap: wrap; margin-bottom: 5px; }
      .wordsync-maimemo-popup .wordsync-row:empty { display: none; }
      .wordsync-maimemo-popup .wordsync-tag { color: var(--fill-secondary, #888); flex: none; }
      .wordsync-maimemo-popup .wordsync-words { max-height: 76px; overflow: auto; }
      .wordsync-maimemo-popup button { cursor: pointer; padding: 2px 7px; font: inherit;
        border: 1px solid var(--fill-quaternary, #aaa); border-radius: 4px;
        color: inherit; background: var(--material-background, transparent); }
      .wordsync-maimemo-popup button:disabled { opacity: .55; cursor: default; }
      .wordsync-maimemo-popup button[aria-pressed="true"] { border-color: #3979ce; }
      .wordsync-maimemo-popup .wordsync-add { flex: none; padding: 3px 11px; }
      .wordsync-maimemo-popup input { flex: 1; min-width: 0; box-sizing: border-box; padding: 3px 6px;
        border: 1px solid var(--fill-quaternary, #aaa); border-radius: 4px; font: inherit;
        color: inherit; background: var(--material-background, transparent); }
      .wordsync-maimemo-popup .wordsync-status { color: var(--fill-secondary, #888); min-height: 16px; }
    `;

export class ReaderPopup {
  constructor({ event, captureService, store, settings, worker, onDispose }) {
    this.event = event;
    this.captureService = captureService;
    this.store = store;
    this.settings = settings;
    this.worker = worker;
    this.onDispose = onDispose;
    this.alive = true;
    this.revision = 0;
    this.busy = false;
    this.listeners = [];
    const annotationText = event.params?.annotation?.text ?? event.params?.text;
    let domSelection = "";
    try {
      domSelection = event.doc?.defaultView?.getSelection?.()?.toString?.() ?? "";
    } catch {
      // The reader document may be exposed through a security wrapper. If
      // reading the DOM selection is denied, the annotation text is still
      // sufficient for the normal path.
    }
    this.selectionText = typeof annotationText === "string" && annotationText.trim()
      ? annotationText
      : domSelection;
    this.candidates = [...new Set(extractWordCandidates(this.selectionText))];
  }

  element(tag, text, className) {
    const element = this.event.doc.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  listen(element, type, handler) {
    element.addEventListener(type, handler);
    this.listeners.push(() => element.removeEventListener(type, handler));
  }

  mount() {
    if (!this.candidates.length) return false;
    this.root = this.element("section", null, "wordsync-maimemo-popup");
    this.root.setAttribute("aria-label", "加入墨墨背单词");
    const style = this.element("style");
    style.textContent = POPUP_STYLE;
    this.root.append(style);

    // 选区里有多个词时先挑一个；只有一个词就不占这一行。
    this.choiceButtons = [];
    if (this.candidates.length > 1) {
      const words = this.element("div", null, "wordsync-row wordsync-words");
      for (const word of this.candidates) {
        const button = this.element("button", word);
        button.type = "button";
        this.listen(button, "click", () => this.selectWord(word));
        this.choiceButtons.push(button);
        words.append(button);
      }
      this.root.append(words);
    }

    this.formRow = this.element("div", null, "wordsync-row");
    this.formButtons = [];
    this.root.append(this.formRow);

    const entry = this.element("div", null, "wordsync-row");
    this.input = this.element("input");
    this.input.type = "text";
    this.input.maxLength = 100;
    this.input.setAttribute("aria-label", "要加入的单词");
    this.addButton = this.element("button", "加入", "wordsync-add");
    this.addButton.type = "button";
    this.addButton.disabled = true;
    entry.append(this.input, this.addButton);

    this.status = this.element("div", "", "wordsync-status");
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.root.append(entry, this.status);

    this.listen(this.input, "input", () => {
      this.markForm(this.input.value);
      void this.refreshStatus();
    });
    this.listen(this.addButton, "click", () => void this.add());
    // 允许编辑框接收焦点，同时防止输入及点击被阅读器当成注释快捷键。
    for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
      this.listen(this.root, type, (event) => event.stopPropagation());
    }
    this.listen(this.root, "keydown", (event) => {
      if (event.key !== "Escape") event.stopPropagation();
      if (event.key === "Enter" && event.target === this.input) {
        event.preventDefault();
        if (!this.addButton.disabled) void this.add();
      }
    });
    this.event.append(this.root);
    this.observeRemoval();
    this.unsubscribe = this.worker.subscribe((state) => {
      this.workerState = state;
      if (!this.busy) void this.refreshStatus();
    });
    this.selectWord(this.candidates[0]);
    return true;
  }

  observeRemoval() {
    const readerWindow = this.event.doc?.defaultView;
    const Observer = readerWindow?.MutationObserver;
    const observerTarget = this.root?.parentNode;
    if (typeof Observer !== "function" || !observerTarget) return;

    const callback = () => {
      if (!this.root?.isConnected) this.dispose();
    };
    try {
      const observer = new Observer(callback);
      observer.observe(observerTarget, { childList: true });
      this.observer = observer;
      return;
    } catch {
      // Zotero may reject an options dictionary crossing the reader iframe's
      // security wrapper. Cleanup is helpful but must never remove a popup
      // that was already appended successfully.
    }

    // In Firefox-based Zotero builds, cloning the dictionary into the reader
    // compartment can satisfy MutationObserver's WebIDL conversion. This is
    // best-effort and remains optional for hosts that do not expose cloneInto.
    const cloneInto = globalThis.Components?.utils?.cloneInto;
    if (typeof cloneInto !== "function") return;
    try {
      const observer = new Observer(callback);
      observer.observe(observerTarget, cloneInto({ childList: true }, readerWindow));
      this.observer = observer;
    } catch {
      // Ignore observer failures; the next reader event and plugin shutdown
      // still dispose the popup through the normal lifecycle.
    }
  }

  selectWord(surface) {
    if (this.busy || !this.alive) return;
    this.surface = surface;
    for (const button of this.choiceButtons) button.setAttribute("aria-pressed", String(button.textContent === surface));
    this.renderForms(surface);
  }

  /**
   * 列出这个词可以加入的形态。墨墨把 attenuate 和 attenuated 当两个词条，
   * 该背动词还是形容词只有读的人知道，所以摆出来让他点，不替他决定。
   */
  renderForms(surface) {
    const choices = lemmaChoices(surface);
    const value = choices[0] ?? surface.toLocaleLowerCase("en-US");
    this.formButtons = [];
    this.formRow.replaceChildren();
    if (choices.length > 1) {
      this.formRow.append(this.element("span", "词形", "wordsync-tag"));
      for (const form of choices) {
        const button = this.element("button", form);
        button.type = "button";
        this.listen(button, "click", () => this.selectForm(form));
        this.formButtons.push(button);
        this.formRow.append(button);
      }
    }
    this.input.value = value;
    this.markForm(value);
    void this.refreshStatus();
  }

  selectForm(form) {
    if (this.busy || !this.alive) return;
    this.input.value = form;
    this.markForm(form);
    void this.refreshStatus();
  }

  markForm(value) {
    const current = value.trim().toLocaleLowerCase("en-US");
    for (const button of this.formButtons) {
      button.setAttribute("aria-pressed", String(button.textContent === current));
    }
  }

  async refreshStatus() {
    const revision = ++this.revision;
    if (!this.alive || this.busy) return;
    this.addButton.disabled = true;
    let lemma;
    try { lemma = normalizeLemma(this.input.value); } catch {
      this.status.textContent = "请输入一个单词原形";
      return;
    }
    try {
      const record = await this.store.findByLemma(lemma);
      if (!this.alive || revision !== this.revision || this.busy) return;
      // 队列整个卡住时（没填 Token、没选云词本、认证失效），说清楚卡在哪，
      // 否则这里只会一直显示「等待同步」，看不出要去做什么。
      const blocked = this.workerState?.kind === "authentication" || this.workerState?.kind === "error";
      this.status.textContent = blocked && (!record || record.status !== "synced")
        ? this.workerState.message
        : wordStatusText(record);
      this.addButton.textContent = record ? (record.status === "synced" ? "已同步" : "已加入") : "加入";
      this.addButton.disabled = Boolean(record);
    } catch (error) {
      if (this.alive && revision === this.revision) this.status.textContent = safeErrorMessage(error);
    }
  }

  async add() {
    if (!this.alive || this.busy || this.addButton.disabled) return;
    // 在异步读取设置前固定本次点击的词，避免选词变化影响保存内容。
    const selectedSurface = this.surface;
    const lemma = this.input.value;
    this.busy = true;
    ++this.revision;
    this.input.disabled = true;
    this.addButton.disabled = true;
    for (const button of [...this.choiceButtons, ...this.formButtons]) button.disabled = true;
    try {
      const config = await this.settings.read();
      const result = await this.captureService.addFromSelection({
        selectionText: this.selectionText, selectedSurface, lemma,
        addToStudyPlan: config.addToStudyPlan,
      });
      this.worker.kick();
      if (this.alive) {
        const blocked = this.workerState?.kind === "authentication" || this.workerState?.kind === "error";
        this.status.textContent = blocked ? this.workerState.message
          : result.kind === "queued" ? "已保存，后台将同步到墨墨" : wordStatusText(result.record);
        this.addButton.textContent = "已加入";
      }
    } catch (error) {
      if (this.alive) {
        this.status.textContent = safeErrorMessage(error);
        this.addButton.disabled = false;
      }
    } finally {
      this.busy = false;
      if (this.alive) {
        this.input.disabled = false;
        for (const button of [...this.choiceButtons, ...this.formButtons]) button.disabled = false;
      }
    }
  }

  dispose() {
    if (!this.alive) return;
    this.alive = false;
    ++this.revision;
    this.observer?.disconnect();
    this.unsubscribe?.();
    for (const remove of this.listeners) remove();
    this.listeners = [];
    this.root?.remove();
    this.onDispose?.(this);
  }
}
