import { RuleLemmatizer } from "../domain/lemmatizer.mjs";
import { WordCaptureService } from "../application/word-capture-service.mjs";
import { WordSyncService } from "../application/word-sync-service.mjs";
import { SyncWorker } from "../application/sync-worker.mjs";
import { SettingsService } from "../application/settings-service.mjs";
import { safeErrorMessage } from "../application/sync-error.mjs";
import { JsonWordStore } from "../infrastructure/json-word-store.mjs";
import { RateLimitedTransport } from "../infrastructure/rate-limited-transport.mjs";
import { MaimemoApiClient } from "../integrations/maimemo/maimemo-api-client.mjs";
import { MaimemoNotepadDirectory, MaimemoNotepadGateway, MaimemoStudyPlanGateway } from "../integrations/maimemo/maimemo-gateways.mjs";
import { createZoteroWordFile } from "../integrations/zotero/file-adapter.mjs";
import { ZoteroPreferences, ZoteroCredentials } from "../integrations/zotero/settings-adapters.mjs";
import { ZoteroHttpTransport } from "../integrations/zotero/http-transport.mjs";
import { ReaderPopup } from "../ui/reader-popup.mjs";
import { SettingsPage } from "../ui/settings-page.mjs";

export const PREFERENCE_PANE_ID = "wordsync-maimemo-pane";
const READER_EVENT = "renderTextSelectionPopup";

export class WordSyncPlugin {
  constructor({ host, pluginID, rootURI, transportOptions = {} }) {
    this.host = host;
    this.Zotero = host.Zotero;
    this.pluginID = pluginID;
    this.rootURI = rootURI;
    this.alive = false;
    this.closed = false;
    this.generation = 0;
    this.popups = new Set();
    this.settingsPages = new Set();
    this.file = createZoteroWordFile(host);
    this.store = new JsonWordStore({ file: this.file });
    // ready 的拒绝仍会传给所有读写操作，但立即处理，避免宿主报告未处理的 Promise。
    this.store.ready.catch(() => {});
    this.preferences = new ZoteroPreferences(host);
    this.credentials = new ZoteroCredentials(host);
    this.http = new ZoteroHttpTransport(host);
    this.transport = new RateLimitedTransport({
      ...transportOptions, fetchImpl: this.http.fetch, timers: host.timers,
    });
    this.captureService = new WordCaptureService({ store: this.store, lemmatizer: new RuleLemmatizer() });
    this.settings = new SettingsService({
      preferences: this.preferences, credentials: this.credentials,
      createDirectory: (token) => new MaimemoNotepadDirectory({ client: this.createClient(token) }),
    });
    this.worker = new SyncWorker({
      store: this.store,
      createSession: () => this.createSession(),
      timers: host.timers,
    });
    this.readerHandler = (event) => this.renderPopup(event);
  }

  createClient(token) {
    const generation = this.generation;
    return new MaimemoApiClient({
      token,
      fetchImpl: (url, options) => this.transport.fetch(url, {
        ...options, isAllowed: () => this.alive && generation === this.generation,
      }),
    });
  }

  async createSession() {
    const generation = this.generation;
    const token = await this.credentials.getToken();
    if (!token || !this.alive) return null;
    const selected = this.preferences.getNotepad();
    if (!selected) throw new Error("尚未选择云词本，请在设置中选择或新建一个");
    const client = this.createClient(token);
    // 每轮同步前确认词本还在，用户可能在 App 里删了或改了名。
    const notepad = await new MaimemoNotepadDirectory({ client }).get(selected.id);
    const syncService = new WordSyncService({
      store: this.store,
      notepadGateway: new MaimemoNotepadGateway({ client }),
      studyPlanGateway: new MaimemoStudyPlanGateway({ client }),
      canSync: () => this.alive && generation === this.generation,
    });
    return { notepad, syncService };
  }

  async start() {
    if (this.alive || this.closed) return;
    await Promise.all([
      this.Zotero.initializationPromise,
      this.Zotero.unlockPromise,
      this.Zotero.uiReadyPromise,
    ]);
    if (this.closed) return;
    this.alive = true;
    this.Zotero.WordSyncMaimemo = this;
    try {
      this.paneID = await this.Zotero.PreferencePanes.register({
        pluginID: this.pluginID, id: PREFERENCE_PANE_ID, label: "墨墨单词同步",
        src: this.rootURI + "content/preferences.xhtml",
        stylesheets: [this.rootURI + "content/preferences.css"],
      });
      if (this.closed) {
        this.Zotero.PreferencePanes.unregister(this.paneID);
        this.paneID = null;
        return;
      }
      this.Zotero.Reader.registerEventListener(READER_EVENT, this.readerHandler, this.pluginID);
      this.readerRegistered = true;
      try {
        await this.store.ready;
        this.worker.kick();
      } catch (error) {
        this.worker.setState("error", safeErrorMessage(error));
      }
    } catch (error) {
      await this.shutdown();
      throw error;
    }
  }

  renderPopup(event) {
    if (!this.alive) return;
    for (const popup of this.popups) {
      if (popup.event.doc === event.doc) popup.dispose();
    }
    const popup = new ReaderPopup({
      event, captureService: this.captureService, store: this.store,
      settings: this.settings, worker: this.worker,
      onDispose: (instance) => this.popups.delete(instance),
    });
    try {
      if (popup.mount()) this.popups.add(popup);
    } catch {
      popup.dispose();
      this.Zotero.debug("墨墨单词同步：阅读器弹窗加载失败");
    }
  }

  async mountPreferences(root) {
    if (!this.alive || [...this.settingsPages].some((view) => view.root === root)) return;
    const view = new SettingsPage({
      root, settings: this.settings, store: this.store, worker: this.worker,
      onConfigurationChange: (action, options) => this.changeConfiguration(action, options),
      onDispose: (instance) => this.settingsPages.delete(instance),
    });
    this.settingsPages.add(view);
    try {
      await view.mount();
    } catch (error) {
      // 设置面板的 onload 吞掉异常就只剩白屏，这里兜住：日志留全栈，界面留一句话。
      this.settingsPages.delete(view);
      try {
        this.Zotero.debug(`墨墨单词同步：设置页加载失败\n${error?.stack || error?.message || error}`);
      } catch {
        // 日志写不进去也不能再抛，否则这里的兜底本身又成了错误源。
      }
      try {
        const notice = root.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "p");
        notice.textContent = `设置页加载失败：${safeErrorMessage(error)}`;
        root.append(notice);
      } catch {
        // 连这句提示都插不进去，就只剩日志了。
      }
    }
  }

  async changeConfiguration(action, { resume }) {
    // 先阻止旧凭据继续发请求，再更新配置。部分完成的步骤仍会落盘。
    this.generation += 1;
    this.worker.pauseAuthentication();
    this.transport.cancelWait();
    this.http.cancelPending();
    await this.worker.running;
    const result = await action();
    if (resume) await this.worker.retry();
    return result;
  }

  async shutdown() {
    this.alive = false;
    this.closed = true;
    this.generation += 1;
    if (this.readerRegistered) {
      this.Zotero.Reader.unregisterEventListener(READER_EVENT, this.readerHandler);
      this.readerRegistered = false;
    }
    for (const popup of [...this.popups]) popup.dispose();
    for (const view of [...this.settingsPages]) view.dispose();
    this.transport.dispose();
    this.http.dispose();
    await this.worker.stop();
    await this.store.tail;
    if (this.paneID) {
      this.Zotero.PreferencePanes.unregister(this.paneID);
      this.paneID = null;
    }
    if (this.Zotero.WordSyncMaimemo === this) delete this.Zotero.WordSyncMaimemo;
  }
}

export function createPlugin(options) { return new WordSyncPlugin(options); }
