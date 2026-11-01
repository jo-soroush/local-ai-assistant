import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { BackendError, normalizeTimeout, postChat, validateBackendUrl } from "../client";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

async function withServer<T>(handler: Handler, fn: (url: string) => Promise<T>): Promise<T> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await fn(url);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

const json = (res: http.ServerResponse, status: number, payload: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
};

test("validateBackendUrl accepts loopback http URLs", () => {
  assert.equal(validateBackendUrl("http://127.0.0.1:8765"), "http://127.0.0.1:8765");
  assert.equal(validateBackendUrl("http://localhost:9000/"), "http://localhost:9000");
  assert.equal(validateBackendUrl("http://[::1]:8765"), "http://[::1]:8765");
});

test("validateBackendUrl rejects non-loopback, non-http, credentials and garbage", () => {
  for (const bad of [
    "http://example.com",
    "http://192.168.1.5:8765",
    "http://0.0.0.0:8765",
    "http://127.0.0.1.evil.com",
    "http://localhost.evil.com",
    "https://127.0.0.1:8765",
    "http://user:pw@127.0.0.1:8765",
    "not a url",
    "",
  ]) {
    assert.throws(() => validateBackendUrl(bad), BackendError, bad);
  }
});

test("normalizeTimeout clamps and defaults", () => {
  assert.equal(normalizeTimeout(undefined), 130000);
  assert.equal(normalizeTimeout(NaN), 130000);
  assert.equal(normalizeTimeout(5), 1000);
  assert.equal(normalizeTimeout(10_000_000), 180000);
  assert.equal(normalizeTimeout(2500), 2500);
});

test("postChat sends JSON and returns reply", async () => {
  await withServer(
    (req, res, body) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/chat");
      assert.deepEqual(JSON.parse(body), { message: "hi" });
      json(res, 200, { request_id: "r1", reply: "hello" });
    },
    async (url) => {
      assert.deepEqual(await postChat(url, "hi", 2000), { requestId: "r1", reply: "hello" });
    }
  );
});

test("postChat includes context only when provided", async () => {
  const ctx = { kind: "selection" as const, path: "a.py", start_line: 1, end_line: 2, text: "x = 1" };
  const bodies: unknown[] = [];
  await withServer(
    (_q, res, body) => {
      bodies.push(JSON.parse(body));
      json(res, 200, { request_id: "r", reply: "ok" });
    },
    async (url) => {
      await postChat(url, "q", 2000, ctx);
      await postChat(url, "q", 2000);
    }
  );
  assert.deepEqual(bodies[0], { message: "q", context: ctx });
  assert.deepEqual(bodies[1], { message: "q" });
});

test("postChat surfaces backend validation error with request id", async () => {
  await withServer(
    (_req, res) =>
      json(res, 422, { error: { code: "validation_error", message: "message: too long" }, request_id: "r2" }),
    async (url) => {
      await assert.rejects(postChat(url, "x", 2000), /422.*message: too long.*r2/);
    }
  );
});

test("postChat handles non-JSON error, malformed success and missing fields", async () => {
  await withServer((_q, res) => { res.writeHead(502); res.end("bad gateway"); }, async (url) => {
    await assert.rejects(postChat(url, "x", 2000), /HTTP 502/);
  });
  await withServer((_q, res) => { res.writeHead(200); res.end("<html>"); }, async (url) => {
    await assert.rejects(postChat(url, "x", 2000), /malformed/);
  });
  await withServer((_q, res) => json(res, 200, { reply: 5 }), async (url) => {
    await assert.rejects(postChat(url, "x", 2000), /malformed/);
  });
});

test("postChat reports unreachable backend", async () => {
  // Bind then close to obtain a port with nothing listening.
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  await assert.rejects(postChat(`http://127.0.0.1:${port}`, "x", 2000), /Cannot reach backend/);
});

test("postChat times out", async () => {
  await withServer(
    () => { /* never respond */ },
    async (url) => {
      await assert.rejects(postChat(url, "x", 1000), /did not respond within 1000 ms/);
    }
  );
});

test("postChat reports a stalled response body as a timeout, not malformed JSON", async () => {
  await withServer(
    (_q, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"request_id":"r1","reply":'); // headers + partial body, then stall
    },
    async (url) => {
      await assert.rejects(postChat(url, "x", 1000), (err: Error) => {
        assert.ok(err instanceof BackendError);
        assert.match(err.message, /did not respond within 1000 ms/);
        assert.doesNotMatch(err.message, /malformed/);
        return true;
      });
    }
  );
});

test("postChat refuses redirects and non-loopback URLs without connecting", async () => {
  await withServer(
    (_q, res) => { res.writeHead(302, { Location: "http://example.com/" }); res.end(); },
    async (url) => {
      await assert.rejects(postChat(url, "x", 2000), BackendError);
    }
  );
  await assert.rejects(postChat("http://example.com", "x", 1000), /not loopback/);
});

test("postChat sends tool_results only when provided (fetch stub, no socket)", async () => {
  const realFetch = globalThis.fetch;
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ request_id: "r1", reply: "ok" }), { status: 200 });
  }) as typeof fetch;
  try {
    const file = { tool: "read_file" as const, path: "a.py", start_line: 1, end_line: 1, text: "x" };
    await postChat("http://127.0.0.1:8765", "hi", 1000, undefined, [file]);
    await postChat("http://127.0.0.1:8765", "hi", 1000, undefined, []);
    await postChat("http://127.0.0.1:8765", "hi");
    assert.deepEqual(bodies, [{ message: "hi", tool_results: [file] }, { message: "hi" }, { message: "hi" }]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
