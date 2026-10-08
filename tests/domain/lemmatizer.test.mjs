import test from "node:test";
import assert from "node:assert/strict";
import { RuleLemmatizer, lemmaCandidates } from "../../src/domain/lemmatizer.mjs";

const lemmatizer = new RuleLemmatizer();

async function check(pairs) {
  for (const [surface, expected] of Object.entries(pairs)) {
    assert.equal(await lemmatizer.lemmatize(surface), expected, `${surface} 应还原为 ${expected}`);
  }
}

test("复数还原，包含学术文本高频的拉丁希腊词尾", async () => {
  await check({
    ablations: "ablation", perturbations: "perturbation", boxes: "box", studies: "study",
    leaves: "leaf", analyses: "analysis", hypotheses: "hypothesis", matrices: "matrix",
    indices: "index", criteria: "criterion", phenomena: "phenomenon", stimuli: "stimulus",
    bacteria: "bacterium", mice: "mouse",
  });
});

test("已经是原形的词不被误削，尤其是以 s 结尾的", async () => {
  await check({ focus: "focus", analysis: "analysis", process: "process", this: "this", status: "status" });
});

test("-ed 与 -ing：该补的 e 补上，不该补的不补", async () => {
  await check({
    converged: "converge", regularized: "regularize", attenuated: "attenuate", denoting: "denote",
    computed: "compute", measured: "measure", proposed: "propose", derived: "derive",
    included: "include", managed: "manage", stored: "store", acquired: "acquire",
    visited: "visit", limited: "limit", exhibited: "exhibit", presented: "present",
    documented: "document", connected: "connect", confounding: "confound",
    contained: "contain", remained: "remain", appeared: "appear", revealed: "reveal",
    allowed: "allow", followed: "follow", considered: "consider",
    cited: "cite", writing: "write", identified: "identify",
  });
});

test("双写辅音：该去重的去重，本身双写的保留", async () => {
  await check({ running: "run", controlled: "control", calling: "call", installed: "install" });
});

test("不规则动词走查表", async () => {
  await check({ is: "be", taught: "teach", understood: "understand", ran: "run", paid: "pay" });
});

test("候选里保留原词与派生形式，供后续用词库仲裁", async () => {
  const candidates = lemmaCandidates("orthogonality");
  assert.ok(candidates.includes("orthogonality"), "原词必须在候选里");
  assert.ok(candidates.includes("orthogonal"), "派生候选应当给出");
  assert.equal(candidates[0], "orthogonality", "派生形式不作首选，避免 quality → qual 这类错误");

  const ambiguous = lemmaCandidates("denoting");
  assert.ok(ambiguous.includes("denote") && ambiguous.includes("denot"),
    "静默 e 歧义的两种拼法都要留着");
});

test("已知限制：元音加 s 的单数词会被当成复数，但原词留在候选里", async () => {
  // bias / atlas 和 ideas / areas 的拼法一样，没有词典就分不开。
  assert.equal(await lemmatizer.lemmatize("bias"), "bia");
  assert.ok(lemmaCandidates("bias").includes("bias"));
});

test("非单词输入不抛错，交给调用方校验", async () => {
  assert.deepEqual(lemmaCandidates(""), []);
  assert.deepEqual(lemmaCandidates("123"), []);
});
