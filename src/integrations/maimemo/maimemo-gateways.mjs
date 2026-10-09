export const DEFAULT_MAIMEMO_NOTEPAD_TITLE = "Zotero 背诵";

// 新建词本的初始内容。墨墨不接受空内容，这是最小的合法写法。
const INITIAL_NOTEPAD_CONTENT = "#Zotero";

export class MaimemoNotepadGateway {
  constructor({ client }) {
    this.client = client;
  }

  async addWord({ notepadId, lemma }) {
    const data = await this.client.getNotepad(notepadId);
    const notepad = data?.notepad;
    if (!notepad || typeof notepad.content !== "string") {
      throw new Error("墨墨未返回完整的云词本内容，已停止写入以保留原数据");
    }
    const content = notepad.content;
    // 词本按 id 认，改名不影响同步；但缺字段时不能写回，否则会把远端字段清空。
    if (typeof notepad.title !== "string" || typeof notepad.brief !== "string"
      || !Array.isArray(notepad.tags) || typeof notepad.status !== "string") {
      throw new Error("墨墨返回的云词本信息不完整，已停止写入以保留原数据");
    }
    const lines = content.split(/\r?\n/).map((line) => line.trim());
    const exists = lines.some((line) => line !== "//" && line.toLocaleLowerCase("en-US") === lemma);
    if (exists) {
      return { added: false, alreadyPresent: true };
    }

    const newline = content.includes("\r\n") ? "\r\n" : "\n";
    // 不重新排版已有文本，更新请求只包含接口接受的可写字段。
    const updatedNotepad = {
      title: notepad.title,
      brief: notepad.brief,
      tags: notepad.tags,
      status: notepad.status,
      content: content + (content && !content.endsWith("\n") ? newline : "") + lemma,
    };
    await this.client.updateNotepad(notepadId, updatedNotepad);
    return { added: true, alreadyPresent: false };
  }
}

export class MaimemoNotepadDirectory {
  constructor({ client }) {
    this.client = client;
  }

  /** 列出账号里的云词本，翻完所有页。「我的收藏」不是云词本，排除掉。 */
  async list() {
    const notepads = [];
    let offset = 0;
    const limit = 10;

    while (true) {
      const page = await this.client.listNotepads({ limit, offset });
      const entries = page?.notepads;
      if (!Array.isArray(entries)) throw new Error("墨墨未返回有效的云词本列表");
      notepads.push(...entries);
      if (entries.length < limit) break;
      offset += limit;
    }

    return notepads
      .filter((notepad) => notepad.type !== "FAVORITE" && typeof notepad.id === "string" && notepad.id)
      .map((notepad) => ({ id: notepad.id, title: String(notepad.title ?? "").trim() || "(未命名)" }));
  }

  /** 校验已选词本还在，顺带把最新标题带回来（用户可能在 App 里改过名）。 */
  async get(notepadId) {
    if (typeof notepadId !== "string" || !notepadId) throw new Error("尚未选择云词本");
    const data = await this.client.getNotepad(notepadId);
    const notepad = data?.notepad;
    if (!notepad) throw new Error("选定的云词本已不存在，请在设置中重新选择");
    return { id: notepadId, title: String(notepad.title ?? "").trim() || "(未命名)" };
  }

  async create({ title, brief = "由 Zotero 单词同步插件创建", tags = ["其他"] }) {
    const name = String(title ?? "").trim();
    if (!name) throw new Error("请填写云词本名称");
    // 创建接口要求 status/content/title/brief/tags 全部给出，而且 content 不能为空：
    // 实测空串返回 400 notepad_invalid_content「云词库不存在」。一个章节标题是
    // 最小的合法内容，建出来的词本不含任何单词。
    const data = await this.client.createNotepad({
      title: name, brief, tags, content: INITIAL_NOTEPAD_CONTENT, status: "UNPUBLISHED",
    });
    const id = data?.notepad?.id;
    if (typeof id !== "string" || !id) throw new Error("墨墨未返回新建云词本的 ID，请刷新列表确认");
    return { id, title: name };
  }
}

export class MaimemoStudyPlanGateway {
  constructor({ client }) {
    this.client = client;
  }

  async addWords({ spellings, advance = true }) {
    const data = await this.client.queryVocabulary(spellings);
    if (!Array.isArray(data?.voc)) throw new Error("墨墨未返回有效的单词查询结果");
    const ids = spellings.map((spelling) => {
      const word = data.voc.find((entry) => entry.spelling?.toLowerCase() === spelling.toLowerCase());
      if (typeof word?.id !== "string" || !word.id) {
        throw new Error(`墨墨词库未收录「${spelling}」，词本步骤已保留`);
      }
      return word.id;
    });
    const result = await this.client.addWordsToStudyPlan(ids, { advance });
    if (result?.added_count === ids.length) return result;
    // 0 可能表示已有此词，也可能是单词上限不足，不能直接标记成功。
    if (!Number.isInteger(result?.added_count) || result.added_count < 0) {
      throw new Error("墨墨未确认学习计划加入结果，请重试核对");
    }
    const study = await this.client.queryStudyRecords(ids);
    const confirmed = Array.isArray(study?.records)
      && ids.every((id) => study.records.some((record) => record.voc_id === id));
    if (!confirmed) {
      throw new Error("墨墨未确认单词进入学习计划，请检查 App 自动同步与单词上限后重试");
    }
    return result;
  }
}
