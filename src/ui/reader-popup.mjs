import { extractWordCandidates } from "../domain/selection.mjs";
import { normalizeLemma } from "../domain/word-record.mjs";
import { safeErrorMessage } from "../application/sync-error.mjs";
import { wordStatusText } from "./word-status.mjs";

export class ReaderPopup {
  constructor({ event, captureService, store, settings, worker, openSettings, onDispose }) {
    this.event = event;
    this.captureService = captureService;
    this.store = store;
    this.settings = settings;
    this.worker = worker;
    this.openSettings = openSettings;
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
    style.textContent = `
      .wordsync-maimemo-popup { border-top: 1px solid var(--fill-quinary, #ddd); padding: 10px 8px;
        width: 260px; max-width: 100%; box-sizing: border-box; font: 13px/1.5 system-ui; color: inherit; }
      .wordsync-maimemo-popup .wordsync-title { font-weight: 600; margin-bottom: 7px; }
      .wordsync-maimemo-popup .wordsync-candidates { display: flex; flex-wrap: wrap; gap: 5px;
        max-height: 100px; overflow: auto; margin-bottom: 8px; }
      .wordsync-maimemo-popup button { cursor: pointer; padding: 4px 9px; font: inherit;
        border: 1px solid var(--fill-quaternary, #aaa); border-radius: 5px;
        color: inherit; background: var(--material-background, transparent); }
      .wordsync-maimemo-popup button:disabled { opacity: .55; cursor: default; }
      .wordsync-maimemo-popup button[aria-pressed="true"] { border-color: #3979ce; }
      .wordsync-maimemo-popup input { box-sizing: border-box; width: 100%; padding: 5px 7px;
        border: 1px solid var(--fill-quaternary, #aaa); border-radius: 5px; font: inherit;
        color: inherit; background: var(--material-background, transparent); }
      .wordsync-maimemo-popup .wordsync-status { margin: 7px 0; min-height: 20px; }
      .wordsync-maimemo-popup .wordsync-actions { display: flex; gap: 7px; justify-content: space-between; }
    `;
    this.root.append(style, this.element("div", "墨墨背单词", "wordsync-title"));
    const chooser = this.element("div", null, "wordsync-candidates");
    this.choiceButtons = [];
    if (this.candidates.length > 1) {
      this.root.append(this.element("div", "选择一个单词："), chooser);
      for (const word of this.candidates) {
        const button = this.element("button", word);
        button.type = "button";
        this.listen(button, "click", () => this.selectWord(word));
        this.choiceButtons.push(button);
        chooser.append(button);
      }
    }
    const label = this.element("label", "单词原形（可修改）：");
    this.input = this.element("input");
    this.input.type = "text";
    this.input.maxLength = 100;
    this.input.setAttribute("aria-label", "单词原形");
    label.append(this.input);
    this.status = this.element("div", "", "wordsync-status");
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.addButton = this.element("button", "加入");
    this.addButton.type = "button";
    this.addButton.disabled = true;
    const settingsButton = this.element("button", "设置");
    settingsButton.type = "button";
    const actions = this.element("div", null, "wordsync-actions");
    actions.append(this.addButton, settingsButton);
    this.root.append(label, this.status, actions);
    this.listen(this.input, "input", () => void this.refreshStatus());
    this.listen(this.addButton, "click", () => void this.add());
    this.listen(settingsButton, "click", () => this.openSettings());
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
    this.unsubscribe = this.worker.subscribe(() => { if (!this.busy) void this.refreshStatus(); });
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
    this.input.value = surface.toLowerCase();
    for (const button of this.choiceButtons) button.setAttribute("aria-pressed", String(button.textContent === surface));
    void this.refreshStatus();
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
      this.status.textContent = wordStatusText(record);
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
    for (const button of this.choiceButtons) button.disabled = true;
    try {
      const config = await this.settings.read();
      const result = await this.captureService.addFromSelection({
        selectionText: this.selectionText, selectedSurface, lemma,
        addToStudyPlan: config.addToStudyPlan,
      });
      this.worker.kick();
      if (this.alive) {
        this.status.textContent = result.kind === "queued" ? "已保存，后台将同步到墨墨" : wordStatusText(result.record);
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
        for (const button of this.choiceButtons) button.disabled = false;
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
