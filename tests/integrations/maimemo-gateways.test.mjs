import test from "node:test";
import assert from "node:assert/strict";
import {
  MaimemoNotepadGateway,
  MaimemoNotepadDirectory,
  MaimemoStudyPlanGateway,
} from "../../src/integrations/maimemo/maimemo-gateways.mjs";

test("notepad gateway preserves remote fields and appends only a missing word", async () => {
  const updates = [];
  const gateway = new MaimemoNotepadGateway({
    client: {
      async getNotepad() {
        return {
          notepad: {
            id: "notepad-1",
            title: "Zotero 背诵",
            status: "PUBLISHED",
            brief: "keep me",
            tags: ["六级"],
            content: "//\nexisting",
          },
        };
      },
      async updateNotepad(id, notepad) {
        updates.push({ id, notepad });
      },
    },
  });

  const result = await gateway.addWord({ notepadId: "notepad-1", lemma: "newword" });

  assert.deepEqual(result, { added: true, alreadyPresent: false });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].notepad.title, "Zotero 背诵");
  assert.equal(updates[0].notepad.brief, "keep me");
  assert.equal(updates[0].notepad.content, "//\nexisting\nnewword");
  assert.equal("id" in updates[0].notepad, false);
});

test("notepad gateway does not rewrite an existing word", async () => {
  let updateCalled = false;
  const gateway = new MaimemoNotepadGateway({
    client: {
      async getNotepad() {
        return { notepad: { title: "Zotero 背诵", status: "PUBLISHED", brief: "", tags: [], content: "//\nmouse" } };
      },
      async updateNotepad() {
        updateCalled = true;
      },
    },
  });

  const result = await gateway.addWord({ notepadId: "notepad-1", lemma: "mouse" });

  assert.deepEqual(result, { added: false, alreadyPresent: true });
  assert.equal(updateCalled, false);
});

test("追加保持章节、空行、缩进与 CRLF，不发送远端只读字段", async () => {
  let update;
  const content = "// 第一章\r\n\r\n  apple  \r\n// 第二章\r\npear";
  const gateway = new MaimemoNotepadGateway({ client: {
    async getNotepad() { return { notepad: { id: "id", title: "Zotero 背诵", brief: "原简介", status: "PUBLISHED", tags: ["考研"], content, creator: 1, list: [] } }; },
    async updateNotepad(id, notepad) { update = notepad; },
  } });
  await gateway.addWord({ notepadId: "id", lemma: "mouse" });
  assert.equal(update.content, content + "\r\nmouse");
  assert.deepEqual(Object.keys(update).sort(), ["brief", "content", "status", "tags", "title"]);
});

test("云词本响应缺少内容时不覆盖远端文件", async () => {
  let called = false;
  const gateway = new MaimemoNotepadGateway({ client: {
    async getNotepad() { return { notepad: { title: "Zotero 背诵" } }; },
    async updateNotepad() { called = true; },
  } });
  await assert.rejects(gateway.addWord({ notepadId: "target", lemma: "mouse" }), /停止写入/);
  assert.equal(called, false);
});

test("学习计划新增数量为零时核对已存在记录，未确认则保留部分成功", async () => {
  let records = [];
  const gateway = new MaimemoStudyPlanGateway({ client: {
    async queryVocabulary() { return { voc: [{ id: "id-mouse", spelling: "mouse" }] }; },
    async addWordsToStudyPlan() { return { added_count: 0 }; },
    async queryStudyRecords() { return { records }; },
  } });
  await assert.rejects(gateway.addWords({ spellings: ["mouse"] }), /未确认单词进入学习计划/);
  records = [{ voc_id: "id-mouse" }];
  assert.deepEqual(await gateway.addWords({ spellings: ["mouse"] }), { added_count: 0 });
});

test("词库未收录时不提交学习计划请求，同名词本不静默选取", async () => {
  let wrote = false;
  const gateway = new MaimemoStudyPlanGateway({ client: {
    async queryVocabulary() { return { voc: [] }; },
    async addWordsToStudyPlan() { wrote = true; },
  } });
  await assert.rejects(gateway.addWords({ spellings: ["unknown"] }), /词库未收录/);
  assert.equal(wrote, false);
});

test("study plan gateway delegates without coupling the sync service to HTTP", async () => {
  let received;
  const gateway = new MaimemoStudyPlanGateway({
    client: {
      async queryVocabulary() { return { voc: [{ id: "voc-mouse", spelling: "mouse" }] }; },
      async addWordsToStudyPlan(ids, options) {
        received = { ids, options };
        return { added_count: 1 };
      },
    },
  });

  const result = await gateway.addWords({ spellings: ["mouse"], advance: true });

  assert.deepEqual(result, { added_count: 1 });
  assert.deepEqual(received, { ids: ["voc-mouse"], options: { advance: true } });
});

test("词本目录翻完所有页，排除「我的收藏」", async () => {
  const requests = [];
  const directory = new MaimemoNotepadDirectory({
    client: {
      async listNotepads(input) {
        requests.push(input);
        if (input.offset === 0) {
          return {
            notepads: Array.from({ length: 10 }, (_, index) => ({
              id: `notepad-${index}`,
              title: `Other ${index}`,
            })),
          };
        }
        return { notepads: [
          { id: "fav", title: "我的收藏", type: "FAVORITE" },
          { id: "target", title: "  Zotero 背诵  " },
        ] };
      },
    },
  });

  const notepads = await directory.list();

  assert.equal(notepads.length, 11, "10 条第一页加上第二页里唯一的云词本");
  assert.deepEqual(notepads.at(-1), { id: "target", title: "Zotero 背诵" });
  assert.equal(notepads.some((notepad) => notepad.id === "fav"), false, "我的收藏不是云词本");
  assert.deepEqual(requests, [
    { limit: 10, offset: 0 },
    { limit: 10, offset: 10 },
  ]);
});

test("词本按 id 校验，改名不影响；删掉了给出可操作的提示", async () => {
  const directory = new MaimemoNotepadDirectory({
    client: { async getNotepad(id) { return id === "live" ? { notepad: { title: "改过名的词本" } } : {}; } },
  });

  assert.deepEqual(await directory.get("live"), { id: "live", title: "改过名的词本" });
  await assert.rejects(directory.get("gone"), /重新选择/);
  await assert.rejects(directory.get(""), /尚未选择云词本/);
});

test("新建词本按接口要求补齐必填字段，并把新 id 带回来", async () => {
  let sent;
  const directory = new MaimemoNotepadDirectory({
    client: { async createNotepad(notepad) { sent = notepad; return { notepad: { id: "created" } }; } },
  });

  assert.deepEqual(await directory.create({ title: "  论文生词  " }), { id: "created", title: "论文生词" });
  assert.deepEqual(Object.keys(sent).sort(), ["brief", "content", "status", "tags", "title"]);
  assert.equal(sent.title, "论文生词");
  assert.equal(sent.status, "UNPUBLISHED", "新建的词本默认不发布");
  // 实测空 content 会被拒：400 notepad_invalid_content。
  assert.equal(sent.content, "#Zotero", "内容不能为空，用一个章节标题占位");
  await assert.rejects(directory.create({ title: "   " }), /请填写云词本名称/);
});

test("账号里一个云词本都没有时返回空列表，不猜一个词本出来", async () => {
  const directory = new MaimemoNotepadDirectory({
    client: { async listNotepads() { return { notepads: [] }; } },
  });

  assert.deepEqual(await directory.list(), []);
});

test("墨墨返回的列表结构不对时报错，不当成空账号", async () => {
  const directory = new MaimemoNotepadDirectory({
    client: { async listNotepads() { return {}; } },
  });

  await assert.rejects(() => directory.list(), /未返回有效的云词本列表/);
});
