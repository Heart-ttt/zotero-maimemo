import { DEFAULT_MAIMEMO_NOTEPAD_TITLE } from "../integrations/maimemo/maimemo-gateways.mjs";

export class SettingsService {
  constructor({ preferences, credentials, resolveNotepad }) {
    this.preferences = preferences;
    this.credentials = credentials;
    this.resolveNotepad = resolveNotepad;
    this.tail = Promise.resolve();
  }

  async read() {
    return {
      notepadTitle: DEFAULT_MAIMEMO_NOTEPAD_TITLE,
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

  async testConnection(draftToken = "") {
    const token = draftToken.trim() || await this.credentials.getToken();
    if (!token) throw new Error("请先填写墨墨开放 API Token");
    // 测试只读取词本列表，不保存草稿、不写词本，也不启动队列。
    return this.resolveNotepad(token);
  }

  async clearToken() {
    await this.tail;
    await this.credentials.clearToken();
    return this.read();
  }
}
