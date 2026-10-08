const TOKEN_HOST = "chrome://zotero";
const TOKEN_REALM = "WordSync Maimemo API";
const STUDY_PLAN_PREF = "wordsync-maimemo.addToStudyPlan";
const NOTEPAD_ID_PREF = "wordsync-maimemo.notepadId";
const NOTEPAD_TITLE_PREF = "wordsync-maimemo.notepadTitle";

export class ZoteroPreferences {
  constructor({ Zotero }) {
    this.prefs = Zotero.Prefs;
  }

  getStudyPlanEnabled() {
    const value = this.prefs.get(STUDY_PLAN_PREF);
    return typeof value === "boolean" ? value : true;
  }

  setStudyPlanEnabled(enabled) {
    this.prefs.set(STUDY_PLAN_PREF, enabled);
  }

  getNotepad() {
    const id = this.prefs.get(NOTEPAD_ID_PREF);
    if (typeof id !== "string" || !id) return null;
    const title = this.prefs.get(NOTEPAD_TITLE_PREF);
    return { id, title: typeof title === "string" && title ? title : "(未命名)" };
  }

  setNotepad(notepad) {
    this.prefs.set(NOTEPAD_ID_PREF, notepad?.id ?? "");
    this.prefs.set(NOTEPAD_TITLE_PREF, notepad?.title ?? "");
  }
}

export class ZoteroCredentials {
  constructor({ Services, Components }) {
    this.logins = Services.logins;
    this.LoginInfo = new Components.Constructor(
      "@mozilla.org/login-manager/loginInfo;1",
      Components.interfaces.nsILoginInfo,
      "init",
    );
  }

  find() {
    return this.logins.findLogins(TOKEN_HOST, null, TOKEN_REALM);
  }

  async getToken() {
    return this.find()[0]?.password ?? null;
  }

  async setToken(token) {
    const login = new this.LoginInfo(TOKEN_HOST, null, TOKEN_REALM, "API Key", token, "", "");
    const existing = this.find();
    if (existing.length) {
      this.logins.modifyLogin(existing[0], login);
      for (const duplicate of existing.slice(1)) this.logins.removeLogin(duplicate);
    } else {
      await this.logins.addLoginAsync(login);
    }
  }

  async clearToken() {
    for (const login of this.find()) this.logins.removeLogin(login);
  }
}
