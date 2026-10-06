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
  };
}
