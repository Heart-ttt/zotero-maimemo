import test from "node:test";
import assert from "node:assert/strict";
import { MaimemoApiClient, MaimemoApiError } from "../../src/integrations/maimemo/maimemo-api-client.mjs";

function response({ status = 200, payload, ok = status >= 200 && status < 300 }) {
  return {
    status,
    ok,
    async json() {
      return payload;
    },
  };
}

test("client sends the token in the authorization header and validates success", async () => {
  let request;
  const client = new MaimemoApiClient({
    token: "test-token",
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return response({ payload: { success: true, data: { notepads: [] } } });
    },
  });

  const data = await client.listNotepads({ offset: 0 });

  assert.deepEqual(data, { notepads: [] });
  assert.equal(request.url, "https://open.maimemo.com/open/api/v1/memo/notepads?limit=10&offset=0");
  assert.equal(request.options.headers.Authorization, "Bearer test-token");
  assert.equal(request.options.headers.Accept, "application/json");
});

test("client sends study plan requests through the isolated adapter", async () => {
  let request;
  const client = new MaimemoApiClient({
    token: "test-token",
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return response({ payload: { success: true, data: { accepted: true } } });
    },
  });

  const data = await client.addWordsToStudyPlan(["voc-mouse"], { advance: true });

  assert.deepEqual(data, { accepted: true });
  assert.equal(request.url, "https://open.maimemo.com/open/api/v1/memo/study/add_words");
  assert.deepEqual(JSON.parse(request.options.body), { words: [{ id: "voc-mouse" }], advance: true });
});

test("client turns API errors into structured errors without exposing the token", async () => {
  const client = new MaimemoApiClient({
    token: "secret-token",
    fetchImpl: async () => response({
      status: 401,
      ok: false,
      payload: {
        success: false,
        errors: [{ code: "common_unauthorized", msg: "Authorization failed" }],
      },
    }),
  });

  await assert.rejects(
    () => client.listNotepads(),
    (error) => {
      assert.ok(error instanceof MaimemoApiError);
      assert.equal(error.status, 401);
      assert.equal(error.code, "common_unauthorized");
      assert.equal(error.message.includes("secret-token"), false);
      return true;
    },
  );
});

test("client rejects an HTML response even when a proxy returns HTTP 200", async () => {
  const client = new MaimemoApiClient({
    token: "test-token",
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      async json() {
        throw new Error("Unexpected token <");
      },
    }),
  });

  await assert.rejects(() => client.listNotepads(), /非 JSON/);
});
