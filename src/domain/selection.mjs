const WORD_TOKEN_PATTERN = /[\p{L}]+(?:['’-][\p{L}]+)*/gu;

export function extractWordCandidates(selectionText) {
  if (typeof selectionText !== "string") {
    throw new TypeError("selectionText must be a string");
  }

  return [...selectionText.matchAll(WORD_TOKEN_PATTERN)].map((match) => match[0]);
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
