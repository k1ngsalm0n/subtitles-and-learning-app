import test from "node:test";
import assert from "node:assert/strict";

import { api, useEngine } from "../public/js/backend.mjs";

// Each case puts back whatever it replaced, so cases don't leak into each other.
function withFetch(fake, run) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  return Promise.resolve(run()).finally(() => {
    globalThis.fetch = real;
  });
}

test("with no engine, api is fetch — same arguments, same reply", async () => {
  const seen = [];
  const reply = new Response("{}");
  await withFetch(
    (path, init) => {
      seen.push([path, init]);
      return Promise.resolve(reply);
    },
    async () => {
      const init = { method: "POST", body: "x" };
      assert.equal(await api("/api/translate", init), reply);
      assert.deepEqual(seen, [["/api/translate", init]]);
    },
  );
});

test("fetch is looked up per call, so one replaced after import is used", async () => {
  await withFetch(
    () => Promise.resolve(new Response("late", { status: 201 })),
    async () => {
      const res = await api("/api/health");
      assert.equal(res.status, 201);
    },
  );
});

test("an engine answers instead of the server", async () => {
  await withFetch(
    () => assert.fail("the server must not be asked"),
    async () => {
      useEngine((path, init) =>
        Response.json({ path, method: init?.method || "GET" }, { status: 404 }),
      );
      try {
        const res = await api("/api/locate", { method: "POST" });
        // The reply is a real Response, so a call site's own status checks work.
        assert.equal(res.ok, false);
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), { path: "/api/locate", method: "POST" });
      } finally {
        useEngine(null);
      }
    },
  );
});

test("an engine that throws looks like a server that couldn't be reached", async () => {
  useEngine(() => {
    throw new TypeError("offline");
  });
  try {
    // A rejection, not a synchronous throw: call sites use .catch() and try/await.
    const pending = api("/api/romanize");
    assert.ok(pending instanceof Promise);
    await assert.rejects(pending, /offline/);
  } finally {
    useEngine(null);
  }
});

test("forgetting the engine goes back to the server", async () => {
  useEngine(() => new Response("engine"));
  useEngine(null);
  await withFetch(
    () => Promise.resolve(new Response("server")),
    async () => {
      assert.equal(await (await api("/api/voices")).text(), "server");
    },
  );
});
