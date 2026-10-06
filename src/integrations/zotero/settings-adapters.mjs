const TOKEN_HOST = "chrome://zotero";
const TOKEN_REALM = "WordSync Maimemo API";
const STUDY_PLAN_PREF = "wordsync-maimemo.addToStudyPlan";

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
