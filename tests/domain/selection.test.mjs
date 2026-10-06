import test from "node:test";
import assert from "node:assert/strict";
import { assertSelectedWord, extractWordCandidates } from "../../src/domain/selection.mjs";

test("extractWordCandidates keeps word tokens and ignores punctuation", () => {
  assert.deepEqual(
    extractWordCandidates("The state-of-the-art method, however, works."),
    ["The", "state-of-the-art", "method", "however", "works"],
  );
});

test("assertSelectedWord accepts a word from a multi-word selection", () => {
  assert.equal(assertSelectedWord("The mice were measured.", "mice"), "mice");
});

test("assertSelectedWord rejects a word outside the selection", () => {
  assert.throws(
    () => assertSelectedWord("The mice were measured.", "mouse"),
    /not contained/,
  );
});
