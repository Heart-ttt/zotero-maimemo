/**
 * 什么算一个英文单词：只认 A-Z a-z，中间可以有一个撇号或连字符。
 *
 * 用 [A-Za-z] 而不是 \p{L}，因为后者把汉字也算作字母——划到中文、标点、
 * 数字时会凭空冒出一堆候选词。墨墨词库本来也只收英文，这些词送过去只会
 * 报未收录。选区里一个英文词都没有时，候选为空，弹窗直接不出现。
 */
export const ENGLISH_WORD_SOURCE = "[A-Za-z]+(?:['\u2019-][A-Za-z]+)*";

export const ENGLISH_WORD_PATTERN = new RegExp(`^${ENGLISH_WORD_SOURCE}$`);

// 先按「连续的字母」整段切，再要求整段都是英文。
// 不能直接用英文规则去扫：那样 café 会被切成 caf，naïve 切成 na 和 ve，
// 凭空造出不存在的词。整段不合格就整段丢掉。
const LETTER_RUN_PATTERN = /[\p{L}]+(?:['\u2019-][\p{L}]+)*/gu;

export function extractWordCandidates(selectionText) {
  if (typeof selectionText !== "string") {
    throw new TypeError("selectionText must be a string");
  }

  return [...selectionText.matchAll(LETTER_RUN_PATTERN)]
    .map((match) => match[0])
    .filter((run) => ENGLISH_WORD_PATTERN.test(run));
}

export function assertSelectedWord(selectionText, selectedSurface) {
  const candidates = extractWordCandidates(selectionText);
  const selected = selectedSurface.normalize("NFKC").trim();
  const found = candidates.some(
    (candidate) => candidate.normalize("NFKC").toLocaleLowerCase("en-US") === selected.toLocaleLowerCase("en-US"),
  );

  if (!found) {
    throw new Error("selected word is not contained in the selection");
  }
  return selected;
}
