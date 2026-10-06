import test from "node:test";
import assert from "node:assert/strict";
import {
  MaimemoNotepadGateway,
  MaimemoNotepadResolver,
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
  const resolver = new MaimemoNotepadResolver({ client: { async listNotepads() {
    return { notepads: [{ id: "1", title: "Zotero 背诵" }, { id: "2", title: "Zotero 背诵" }] };
  } } });
  await assert.rejects(resolver.resolve(), /多个同名云词本/);
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

test("notepad resolver finds the single configured target across pages", async () => {
  const requests = [];
  const resolver = new MaimemoNotepadResolver({
    title: "Zotero 背诵",
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
        return { notepads: [{ id: "target", title: "Zotero 背诵" }] };
      },
    },
  });

  assert.deepEqual(await resolver.resolve(), { id: "target", title: "Zotero 背诵" });
  assert.deepEqual(requests, [
    { limit: 10, offset: 0 },
    { limit: 10, offset: 10 },
  ]);
});

test("notepad resolver fails instead of silently selecting another wordbook", async () => {
  const resolver = new MaimemoNotepadResolver({
    client: { async listNotepads() { return { notepads: [] }; } },
  });

  await assert.rejects(() => resolver.resolve(), /云词本不存在/);
});
