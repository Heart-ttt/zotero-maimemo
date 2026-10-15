/* global WebSocket */
// 用无头 Chromium 打开仓库里的合成页面并截图，README 的演示视频和流程图都靠它渲染。
//
// 不引入 Playwright 之类的依赖：Node 自带 WebSocket，直接走 Chrome DevTools 协议。
// 浏览器按 CHROME_PATH、Playwright 缓存、Chrome、Edge 的顺序找。
//
// 页面约定：脚本里挂一个 window.sceneReady（Promise），图片加载和预处理完成后 resolve，
// 返回值原样交给调用方。
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

function findBrowser() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = path.join(homedir(), "Library/Caches/ms-playwright");
  const candidates = [];
  if (existsSync(cache)) {
    for (const entry of readdirSync(cache).filter((name) => name.startsWith("chromium_headless_shell-")).sort().reverse()) {
      candidates.push(path.join(cache, entry, "chrome-headless-shell-mac-arm64/chrome-headless-shell"));
      candidates.push(path.join(cache, entry, "chrome-headless-shell-mac-x64/chrome-headless-shell"));
    }
  }
  candidates.push(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  );
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("找不到 Chromium 内核浏览器，请用 CHROME_PATH 指定");
  return found;
}

// 只监听 127.0.0.1，只提供仓库内的文件。页面要读截图像素，file:// 下画布会被污染，所以走 http。
function startServer() {
  const server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const filePath = path.join(ROOT, pathname);
    if (!filePath.startsWith(ROOT + path.sep)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(filePath);
      response.writeHead(200, { "content-type": CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function launchBrowser(executable, profileDir) {
  const child = spawn(executable, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  return new Promise((resolve, reject) => {
    let output = "";
    child.stderr.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) resolve({ child, endpoint: match[1] });
    });
    child.on("exit", (code) => reject(new Error(`浏览器提前退出（${code}）：${output.slice(-500)}`)));
  });
}

class DevToolsConnection {
  constructor(endpoint) {
    this.socket = new WebSocket(endpoint);
    this.nextId = 1;
    this.pending = new Map();
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
      else waiter.resolve(message.result);
    });
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
  }

  async send(method, params = {}, sessionId = undefined) {
    await this.opened;
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  close() {
    this.socket.close();
  }
}

// 打开 scenePath（相对仓库根目录）指向的页面，等 sceneReady 完成后把操作句柄交给 work。
// work 结束（或出错）后关掉浏览器和本地服务器。viewport 可以带 deviceScaleFactor，截出高分屏用的图。
export async function withScene(scenePath, viewport, work) {
  const server = await startServer();
  const profileDir = await mkdtemp(path.join(tmpdir(), "readme-media-"));
  const { child, endpoint } = await launchBrowser(findBrowser(), profileDir);
  const connection = new DevToolsConnection(endpoint);

  try {
    const { targetId } = await connection.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true });
    const page = (method, params) => connection.send(method, params, sessionId);

    const resize = (size) => page("Emulation.setDeviceMetricsOverride", { deviceScaleFactor: 1, mobile: false, ...size });
    const evaluate = async (expression) => {
      const { result, exceptionDetails } = await page("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      return result.value;
    };
    const screenshot = async () => {
      const { data } = await page("Page.captureScreenshot", { format: "png" });
      return Buffer.from(data, "base64");
    };

    await resize(viewport);
    await page("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/${scenePath}` });
    // 先等页面脚本挂上 sceneReady，再等它完成。
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await evaluate("typeof window.sceneReady === 'object'")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const info = await evaluate("window.sceneReady");
    return await work({ info, evaluate, screenshot, resize });
  } finally {
    connection.close();
    child.kill();
    server.close();
    await rm(profileDir, { recursive: true, force: true });
  }
}
