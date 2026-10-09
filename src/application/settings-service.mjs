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
    // Token 明文回填到输入框：它只是墨墨的开放 API 凭证，不绑定支付或身份，
    // 一直显示比「已保存，留空保留」那种猜谜式提示好用。
    const token = (await this.credentials.getToken()) ?? "";
    return {
      notepad: this.preferences.getNotepad(),
      addToStudyPlan: this.preferences.getStudyPlanEnabled(),
      token,
      hasToken: Boolean(token),
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

  /** 只建，不接管当前词本。换不换由用户再点一次「使用所选词本」决定。 */
  async createNotepad({ title }, draftToken = "") {
    const directory = this.createDirectory(await this.resolveToken(draftToken));
    return directory.create({ title });
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

  /**
   * 只验 Token 能不能用。列一次词本是最轻的只读调用，不写任何东西、不启动队列。
   *
   * 这里不检查已选词本还在不在：没选词本不是「连接失败」，词本被删了也该在
   * 列表和同步那边报，不该让人以为是 Token 的问题。
   */
  async testConnection(draftToken = "") {
    const directory = this.createDirectory(await this.resolveToken(draftToken));
    // 顺手把列表回给调用方，免得测完再查一次，同样的请求发两遍。
    return directory.list();
  }

  async clearToken() {
    await this.tail;
    await this.credentials.clearToken();
    return this.read();
  }
}
