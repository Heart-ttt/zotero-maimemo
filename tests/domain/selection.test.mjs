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

test("只认英文，中文、标点、数字都不算词", () => {
  assert.deepEqual(extractWordCandidates("这是一段中文"), []);
  assert.deepEqual(extractWordCandidates("，。；：！？——…（）「」"), []);
  assert.deepEqual(extractWordCandidates("2024 42.5 100%"), []);
  assert.deepEqual(extractWordCandidates("数式 α β γ ∑ ∫"), []);
  assert.deepEqual(extractWordCandidates("   "), []);
});

test("中英混排只挑出英文词，中文部分整段丢掉", () => {
  assert.deepEqual(extractWordCandidates("这个 attenuated 信号很弱"), ["attenuated"]);
  assert.deepEqual(extractWordCandidates("见 Smith 等人 2024 年的 ablation 实验"), ["Smith", "ablation"]);
});

test("撇号与连字符在词中间算同一个词，在边上不算", () => {
  assert.deepEqual(extractWordCandidates("don't state-of-the-art"), ["don't", "state-of-the-art"]);
  assert.deepEqual(extractWordCandidates("-lead- 'quoted'"), ["lead", "quoted"]);
});

test("带重音的词整个丢掉，不切成碎片", () => {
  assert.deepEqual(extractWordCandidates("naïve café résumé"), [],
    "café 不能被切成 caf");
  assert.deepEqual(extractWordCandidates("the naïve model"), ["the", "model"],
    "同一句里合格的词照常保留");
  assert.deepEqual(extractWordCandidates("中文attenuated"), [],
    "中英连在一起没有分隔时整段算不合格，要选就单独选英文那段");
});
