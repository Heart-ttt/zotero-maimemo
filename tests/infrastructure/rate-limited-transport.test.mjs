import test from "node:test";
import assert from "node:assert/strict";
import { RateLimitedTransport } from "../../src/infrastructure/rate-limited-transport.mjs";
import { ManualTimers, settle } from "../helpers/fakes.mjs";

test("查询与写入共用滑动窗口，429 冷却与卸载取消等待", async () => {
  let now = 0;
  let calls = 0;
  const timers = new ManualTimers();
  const transport = new RateLimitedTransport({
    now: () => now, timers, minimumInterval: 0, windows: [{ duration: 10000, maximum: 2 }],
    fetchImpl: async () => ({ status: ++calls === 3 ? 429 : 200 }),
  });
  await transport.fetch("read", {});
  await transport.fetch("write", {});
  const limited = transport.fetch("read", {});
  await settle();
  assert.equal(calls, 2);
  assert.equal([...timers.tasks.values()][0].delay, 10000);
  now = 10000;
  timers.runNext();
  await limited;
  const cooldown = transport.fetch("write", {});
  await settle();
  assert.equal([...timers.tasks.values()][0].delay, 60000);
  transport.dispose();
  await assert.rejects(cooldown, /已停止/);
  assert.equal(timers.tasks.size, 0);
  assert.equal(calls, 3);
});
