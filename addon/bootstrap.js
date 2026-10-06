var wordSyncRuntime;

function describeStartupError(error) {
  if (!error) return "未知错误";
  const name = typeof error.name === "string" ? error.name : "Error";
  const message = typeof error.message === "string" ? error.message : String(error);
  const stack = typeof error.stack === "string" ? error.stack : "";
  return `${name}: ${message}${stack && stack !== message ? `\n${stack}` : ""}`;
}

function logStartup(message, error) {
  const detail = error ? `\n${describeStartupError(error)}` : "";
  const text = `墨墨单词同步：${message}${detail}`;
  try {
    Zotero.debug(text);
  } catch {
    // 启动阶段如果 Zotero.debug 尚不可用，则忽略日志错误。
  }
}

function install(data, reason) {}
function uninstall(data, reason) {}

async function startup({ id, rootURI }, reason) {
  try {
    // 热更新时先释放上一版监听器和 UI。
    await Zotero.WordSyncMaimemo?.shutdown();
    // Zotero 10 的 bootstrap 沙箱不再提供 importGlobalProperties；这些对象在
    // 主进程全局可用，旧版 Firefox 则通过对应的 JSM 按需导入。
    const ioUtils = typeof IOUtils !== "undefined"
      ? IOUtils
      : ChromeUtils.importESModule("resource://gre/modules/IOUtils.sys.mjs").IOUtils;
    const pathUtils = typeof PathUtils !== "undefined"
      ? PathUtils
      : ChromeUtils.importESModule("resource://gre/modules/PathUtils.sys.mjs").PathUtils;
    const urlConstructor = typeof URL !== "undefined" ? URL : globalThis.URL;
    const timers = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
    const scope = { URL: urlConstructor };
    Services.scriptloader.loadSubScript(rootURI + "content/runtime.js", scope);
    wordSyncRuntime = scope.WordSyncBundle.createPlugin({
      host: { Zotero, Services, Components, IOUtils: ioUtils, PathUtils: pathUtils, timers },
      pluginID: id,
      rootURI,
    });
    await wordSyncRuntime.start();
    logStartup("启动完成");
  } catch (error) {
    // 错误信息不包含 Token；记录完整堆栈以便定位启动阶段的问题。
    logStartup("启动失败", error);
    try { await wordSyncRuntime?.shutdown(); } catch (shutdownError) { logStartup("清理失败", shutdownError); }
    wordSyncRuntime = null;
  }
}

async function shutdown(data, reason) {
  await wordSyncRuntime?.shutdown();
  wordSyncRuntime = null;
}
