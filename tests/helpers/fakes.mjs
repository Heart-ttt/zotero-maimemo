export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export const settle = () => new Promise((resolve) => setImmediate(resolve));

export class ManualTimers {
  constructor() { this.tasks = new Map(); this.nextID = 0; }
  setTimeout = (callback, delay) => {
    const id = ++this.nextID;
    this.tasks.set(id, { callback, delay });
    return id;
  };
  clearTimeout = (id) => this.tasks.delete(id);
  runNext() {
    const [id, task] = this.tasks.entries().next().value;
    this.tasks.delete(id);
    task.callback();
    return task.delay;
  }
}

export function createHost({ token = null, request } = {}) {
  const files = new Map();
  const prefs = new Map();
  const logins = [];
  const listeners = new Map();
  const panes = new Map();
  const calls = [];
  const timers = new ManualTimers();
  const host = {
    timers,
    IOUtils: { async exists(path) { return files.has(path); } },
    PathUtils: { join: (...parts) => parts.join("/") },
    Components: {
      interfaces: { nsILoginInfo: {} },
      Constructor: function () {
        return class {
          constructor(hostname, formSubmitURL, httpRealm, username, password) {
            Object.assign(this, { hostname, formSubmitURL, httpRealm, username, password });
          }
        };
      },
    },
    Services: { logins: {
      findLogins(hostname, formSubmitURL, httpRealm) {
        return logins.filter((login) => login.hostname === hostname && login.httpRealm === httpRealm);
      },
      async addLoginAsync(login) { logins.push(login); },
      modifyLogin(old, next) { logins.splice(logins.indexOf(old), 1, next); },
      removeLogin(login) { logins.splice(logins.indexOf(login), 1); },
    } },
    Zotero: {
      initializationPromise: Promise.resolve(), unlockPromise: Promise.resolve(), uiReadyPromise: Promise.resolve(),
      DataDirectory: { dir: "/test-data" },
      File: {
        async getContentsAsync(path) { return files.get(path); },
        async putContentsAsync(path, content) { files.set(path, content); },
      },
      Prefs: { get: (key) => prefs.get(key), set: (key, value) => prefs.set(key, value) },
      HTTP: { async request(method, url, options) {
        calls.push({ method, url, options });
        return request ? request(method, url, options) : { status: 200, responseText: JSON.stringify({ success: true, data: { notepads: [] } }) };
      } },
      Reader: {
        registerEventListener(type, handler, pluginID) {
          if (listeners.has(type)) throw new Error("duplicate reader registration");
          listeners.set(type, { handler, pluginID });
        },
        unregisterEventListener(type, handler) {
          if (listeners.get(type)?.handler === handler) listeners.delete(type);
        },
      },
      PreferencePanes: {
        async register(pane) { panes.set(pane.id, pane); return pane.id; },
        unregister(id) { panes.delete(id); },
      },
      Utilities: { Internal: { openPreferences(id) { host.openedPane = id; } } },
      debug() {},
    },
    files, prefs, logins, listeners, panes, calls,
  };
  if (token) logins.push({ hostname: "chrome://zotero", httpRealm: "WordSync Maimemo API", password: token });
  return host;
}
