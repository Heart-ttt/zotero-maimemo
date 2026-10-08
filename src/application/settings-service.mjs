import { DEFAULT_MAIMEMO_NOTEPAD_TITLE } from "../integrations/maimemo/maimemo-gateways.mjs";

export { DEFAULT_MAIMEMO_NOTEPAD_TITLE };

export class SettingsService {
  constructor({ preferences, credentials, createDirectory }) {
    this.preferences = preferences;
    this.credentials = credentials;
    this.createDirectory = createDirectory;
    this.tail = Promise.resolve();
  }

  async read() {
    return {
      notepad: this.preferences.getNotepad(),
      addToStudyPlan: this.preferences.getStudyPlanEnabled(),
      hasToken: Boolean(await this.credentials.getToken()),
    };
  }

  save({ token = "", addToStudyPlan }) {
    const task = this.tail.then(async () => {
      const value = token.trim();
      if (value && /\s/.test(value)) throw new Error("Token 中不能包含空格或换行");
      if (value) await this.credentials.setToken(value);
      this.preferences.setStudyPlanEnabled(Boolean(addToStudyPlan));
      return this.read();
    });
    this.tail = task.catch(() => {});
    return task;
  }

  /** 草稿 Token 优先，方便还没保存就先查词本。 */
  async resolveToken(draftToken = "") {
    const token = draftToken.trim() || await this.credentials.getToken();
    if (!token) throw new Error("请先填写墨墨开放 API Token");
    return token;
  }

  async listNotepads(draftToken = "") {
    const directory = this.createDirectory(await this.resolveToken(draftToken));
    return directory.list();
  }

  async createNotepad({ title }, draftToken = "") {
    const directory = this.createDirectory(await this.resolveToken(draftToken));
    const notepad = await directory.create({ title });
    return this.selectNotepad(notepad);
  }

  selectNotepad(notepad) {
    const task = this.tail.then(async () => {
      if (!notepad?.id) throw new Error("请选择一个云词本");
      this.preferences.setNotepad({ id: notepad.id, title: notepad.title ?? "" });
      return this.read();
    });
    this.tail = task.catch(() => {});
    return task;
  }

  /** 只读：验证 Token 能用，并确认已选词本还在。不写任何东西，也不启动队列。 */
  async testConnection(draftToken = "") {
    const directory = this.createDirectory(await this.resolveToken(draftToken));
    const selected = this.preferences.getNotepad();
    if (!selected) {
      const notepads = await directory.list();
      throw new Error(`Token 可用，账号里有 ${notepads.length} 个云词本，请先选择一个`);
    }
    return directory.get(selected.id);
  }

  async clearToken() {
    await this.tail;
    await this.credentials.clearToken();
    return this.read();
  }
}
