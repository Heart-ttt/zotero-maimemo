import test from "node:test";
import assert from "node:assert/strict";
import { MaimemoApiClient } from "../../src/integrations/maimemo/maimemo-api-client.mjs";
import {
  DEFAULT_MAIMEMO_NOTEPAD_TITLE,
  MaimemoNotepadResolver,
} from "../../src/integrations/maimemo/maimemo-gateways.mjs";

const runLiveTest = process.env.RUN_MAIMEMO_LIVE === "1" && Boolean(process.env.MAIMEMO_TOKEN);

test("墨墨 live: token can read the configured target cloud wordbook", {
  skip: runLiveTest ? false : "set RUN_MAIMEMO_LIVE=1 and MAIMEMO_TOKEN to run read-only checks",
}, async () => {
  const client = new MaimemoApiClient({ token: process.env.MAIMEMO_TOKEN });
  const resolver = new MaimemoNotepadResolver({ client, title: DEFAULT_MAIMEMO_NOTEPAD_TITLE });
  const target = await resolver.resolve();

  assert.equal(target.title, DEFAULT_MAIMEMO_NOTEPAD_TITLE);
  assert.ok(target.id);
});
