// 设置页和后台队列共用一个传输层，避免各自限速后仍超出账号限制。
export class RateLimitedTransport {
  constructor({ fetchImpl, timers = globalThis, now = Date.now, minimumInterval = 1600,
    windows = [{ duration: 10000, maximum: 20 }, { duration: 60000, maximum: 40 },
      { duration: 5 * 60 * 60 * 1000, maximum: 2000 }] }) {
    this.fetchImpl = fetchImpl;
    this.timers = timers;
    this.now = now;
    this.minimumInterval = minimumInterval;
    this.windows = windows;
    this.timestamps = [];
    this.tail = Promise.resolve();
    this.closed = false;
    this.waiter = null;
    this.cooldownUntil = 0;
  }

  fetch = (url, options) => {
    const task = this.tail.then(async () => {
      if (this.closed) throw new Error("同步已停止");
      if (options.isAllowed && !options.isAllowed()) throw new Error("同步配置已变化，请重试");
      let delay = this.requiredDelay();
      while (delay > 0) {
        await this.wait(delay);
        delay = this.requiredDelay();
      }
      if (this.closed) throw new Error("同步已停止");
      if (options.isAllowed && !options.isAllowed()) throw new Error("同步配置已变化，请重试");
      this.timestamps.push(this.now());
      const response = await this.fetchImpl(url, options);
      if (response.status === 429) this.cooldownUntil = this.now() + 60000;
      return response;
    });
    this.tail = task.catch(() => {});
    return task;
  };

  requiredDelay() {
    const time = this.now();
    const longest = Math.max(...this.windows.map((window) => window.duration));
    this.timestamps = this.timestamps.filter((stamp) => stamp > time - longest);
    let until = Math.max(this.cooldownUntil,
      this.timestamps.length ? this.timestamps.at(-1) + this.minimumInterval : time);
    for (const window of this.windows) {
      const recent = this.timestamps.filter((stamp) => stamp > time - window.duration);
      if (recent.length >= window.maximum) {
        // 这个窗口已经满了，要等最早那次请求滑出窗口。
        const earliestInWindow = recent[recent.length - window.maximum];
        until = Math.max(until, earliestInWindow + window.duration);
      }
    }
    return Math.max(0, until - time);
  }

  wait(delay) {
    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        this.waiter = null;
        resolve();
      }, delay);
      this.waiter = { timer, reject };
    });
  }

  dispose() {
    this.closed = true;
    this.cancelWait();
  }

  cancelWait() {
    if (this.waiter) {
      this.timers.clearTimeout(this.waiter.timer);
      this.waiter.reject(new Error("同步已停止"));
      this.waiter = null;
    }
  }
}
