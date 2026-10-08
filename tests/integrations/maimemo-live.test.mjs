import test from "node:test";
import assert from "node:assert/strict";
import { MaimemoApiClient } from "../../src/integrations/maimemo/maimemo-api-client.mjs";
import { MaimemoNotepadDirectory } from "../../src/integrations/maimemo/maimemo-gateways.mjs";

const runLiveTest = process.env.RUN_MAIMEMO_LIVE === "1" && Boolean(process.env.MAIMEMO_TOKEN);

test("墨墨 live: token 能列出账号里的云词本", {
  skip: runLiveTest ? false : "set RUN_MAIMEMO_LIVE=1 and MAIMEMO_TOKEN to run read-only checks",
}, async () => {
  const client = new MaimemoApiClient({ token: process.env.MAIMEMO_TOKEN });
  const notepads = await new MaimemoNotepadDirectory({ client }).list();

  assert.ok(Array.isArray(notepads));
  for (const notepad of notepads) {
    assert.equal(typeof notepad.id, "string");
    assert.equal(typeof notepad.title, "string");
  }
});
