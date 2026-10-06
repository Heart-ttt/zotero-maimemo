export const DEFAULT_MAIMEMO_NOTEPAD_TITLE = "Zotero 背诵";

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
    if (notepad.title?.trim() !== DEFAULT_MAIMEMO_NOTEPAD_TITLE
      || typeof notepad.brief !== "string" || !Array.isArray(notepad.tags)
      || typeof notepad.status !== "string") {
      throw new Error("云词本信息不完整或名称已变化，请检查「Zotero 背诵」词本");
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

export class MaimemoNotepadResolver {
  constructor({ client, title = DEFAULT_MAIMEMO_NOTEPAD_TITLE }) {
    this.client = client;
    this.title = title;
  }

  async resolve() {
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

    const matches = notepads.filter((notepad) => notepad.title?.trim() === this.title);
    if (matches.length > 1) throw new Error(`存在多个同名云词本：${this.title}；请保留一个目标词本`);
    const match = matches[0];
    if (!match) {
      throw new Error(`墨墨云词本不存在：${this.title}`);
    }
    if (typeof match.id !== "string" || !match.id) throw new Error("目标云词本 ID 无效");
    return { id: match.id, title: match.title };
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
    if (!Array.isArray(study?.records) || ids.some((id) => !study.records.some((record) => record.voc_id === id))) {
      throw new Error("墨墨未确认单词进入学习计划，请检查 App 自动同步与单词上限后重试");
    }
    return result;
  }
}
