export function createZoteroWordFile({ Zotero, IOUtils, PathUtils }) {
  const path = PathUtils.join(Zotero.DataDirectory.dir, "wordsync-maimemo.json");
  return {
    path,
    async read() {
      if (!await IOUtils.exists(path)) return null;
      return Zotero.File.getContentsAsync(path);
    },
    async writeAtomic(text) {
      // Zotero 的文件工具使用临时文件 + 原子替换，不直接截断原文件。
      await Zotero.File.putContentsAsync(path, text);
    },
    async append(text) {
      try {
        await IOUtils.writeUTF8(path, text, { mode: "appendOrCreate" });
      } catch {
        // 个别版本不支持追加模式，退回读改写：慢一点，但结果一样。
        const current = (await IOUtils.exists(path)) ? await Zotero.File.getContentsAsync(path) : "";
        await Zotero.File.putContentsAsync(path, current + text);
      }
    },
  };
}
