// Sidebar regression tests. The real extension.ts (provider, handlers, outbox wiring) runs against a fake
// `vscode` module, so replacement-before-disposal and hidden-view delivery are exercised end to end.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Outbox } from "../view";

// ---- Outbox (pure) ----

type Msg = { type: string; n?: number };
const tick = () => new Promise<void>((r) => setImmediate(r));

function outbox(opts: { accept?: () => boolean; alive?: () => boolean; coalesce?: string[] } = {}) {
  const delivered: Msg[] = [];
  const box = new Outbox<Msg>(
    async (m) => {
      if (opts.accept && !opts.accept()) {
        return false;
      }
      delivered.push(m);
      return true;
    },
    opts.alive ?? (() => true),
    new Set(opts.coalesce ?? [])
  );
  return { box, delivered };
}

test("outbox keeps undelivered messages and replays them once, in order", async () => {
  let open = false;
  const { box, delivered } = outbox({ accept: () => open });
  box.post({ type: "reply", n: 1 });
  box.post({ type: "error", n: 2 });
  box.post({ type: "reply", n: 3 });
  await tick();
  assert.equal(delivered.length, 0);
  assert.equal(box.pending, 3);
  open = true;
  await box.flush();
  await tick();
  await box.flush();
  await tick();
  assert.deepEqual(delivered.map((m) => m.n), [1, 2, 3]);
  assert.equal(box.pending, 0);
});

test("outbox delivers immediately when the view accepts messages", async () => {
  const { box, delivered } = outbox();
  box.post({ type: "reply", n: 1 });
  box.post({ type: "reply", n: 2 });
  await tick();
  assert.deepEqual(delivered.map((m) => m.n), [1, 2]);
});

test("outbox coalesces state snapshots but never conversational messages", async () => {
  let open = false;
  const { box, delivered } = outbox({ accept: () => open, coalesce: ["context"] });
  box.post({ type: "context", n: 1 });
  await tick(); // the first send has been refused; it is no longer in flight
  box.post({ type: "reply", n: 2 });
  box.post({ type: "context", n: 3 });
  box.post({ type: "reply", n: 4 });
  await tick();
  open = true;
  await box.flush();
  await tick();
  assert.deepEqual(delivered.map((m) => `${m.type}${m.n}`), ["reply2", "context3", "reply4"]);
});

test("closing the outbox drops everything undelivered and later posts", async () => {
  let open = false;
  const { box, delivered } = outbox({ accept: () => open });
  box.post({ type: "reply", n: 1 });
  await tick();
  box.close();
  open = true;
  await box.flush();
  box.post({ type: "reply", n: 2 });
  await tick();
  assert.equal(delivered.length, 0);
});

test("a view that is no longer alive never receives queued messages", async () => {
  let alive = true;
  let open = false;
  const { box, delivered } = outbox({ accept: () => open, alive: () => alive });
  box.post({ type: "reply", n: 1 });
  await tick();
  alive = false;
  open = true;
  await box.flush();
  await tick();
  assert.equal(delivered.length, 0);
  assert.equal(box.pending, 0);
});

test("showing the view while a send is still in flight does not strand the message", async () => {
  let open = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const delivered: Msg[] = [];
  let attempts = 0;
  const box = new Outbox<Msg>(async (m) => {
    const accepted = open; // decided when the host receives the message, answered later
    attempts++;
    await gate;
    if (!accepted) {
      return false;
    }
    delivered.push(m);
    return true;
  }, () => true);
  box.post({ type: "reply", n: 1 });
  await tick();
  open = true; // the view becomes visible while the first send is pending
  void box.flush();
  release();
  await tick();
  await tick();
  assert.deepEqual(delivered.map((m) => m.n), [1]);
  assert.equal(attempts, 2);
});

test("a send that throws (disposed webview) closes the outbox", async () => {
  const box = new Outbox<Msg>(
    async () => {
      throw new Error("Webview is disposed");
    },
    () => true
  );
  box.post({ type: "reply", n: 1 });
  await tick();
  assert.equal(box.pending, 0);
});

// ---- real extension.ts against a fake vscode ----

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rise-sidebar-")));
const WS = path.join(base, "ws");
fs.mkdirSync(path.join(WS, "src"), { recursive: true });
fs.writeFileSync(path.join(WS, "src", "app.py"), "def add(a, b):\n    return a + b\n");

type Handler = (...args: any[]) => any;

interface FakeView {
  posted: any[];
  accept: boolean;
  visible: boolean;
  disposed: boolean;
  api: any;
  send(message: unknown): Promise<void>;
  show(): Promise<void>;
  hide(): void;
  dispose(): void;
}

function makeView(): FakeView {
  const msgCbs: Handler[] = [];
  const visCbs: Handler[] = [];
  const disposeCbs: Handler[] = [];
  const v: FakeView = {
    posted: [],
    accept: true,
    visible: true,
    disposed: false,
    api: undefined,
    async send(message) {
      await Promise.all(msgCbs.map((cb) => cb(message)));
    },
    async show() {
      v.accept = true;
      v.visible = true;
      visCbs.forEach((cb) => cb());
      await tick();
    },
    hide() {
      v.accept = false;
      v.visible = false;
    },
    dispose() {
      v.disposed = true;
      disposeCbs.forEach((cb) => cb());
    },
  };
  v.api = {
    get visible() {
      return v.visible;
    },
    webview: {
      options: undefined,
      html: "",
      cspSource: "vscode-resource:",
      postMessage: async (m: unknown) => {
        if (v.disposed) {
          throw new Error("Webview is disposed");
        }
        if (!v.accept) {
          return false;
        }
        v.posted.push(m);
        return true;
      },
      onDidReceiveMessage: (cb: Handler) => (msgCbs.push(cb), { dispose() {} }),
    },
    onDidChangeVisibility: (cb: Handler) => (visCbs.push(cb), { dispose() {} }),
    onDidDispose: (cb: Handler) => (disposeCbs.push(cb), { dispose() {} }),
  };
  return v;
}

const calls = { inputBox: 0, quickPick: 0, executed: [] as string[], fetch: [] as any[], modelInfo: 0 };
const registered: { provider?: any; options?: any; id?: string; commands: Record<string, Handler> } = { commands: {} };
const disposable = { dispose() {} };
const fakeVscode = {
  window: {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    onDidChangeActiveTextEditor: () => disposable,
    onDidChangeTextEditorSelection: () => disposable,
    registerWebviewViewProvider: (id: string, provider: any, options: any) => {
      Object.assign(registered, { id, provider, options });
      return disposable;
    },
    showInputBox: async () => (calls.inputBox++, "app"),
    showQuickPick: async (items: string[]) => (calls.quickPick++, items[0]),
  },
  workspace: {
    workspaceFolders: [{ name: "proj", uri: { fsPath: WS } }],
    onDidChangeWorkspaceFolders: () => disposable,
    getConfiguration: () => ({ get: (_k: string, d: unknown) => d }),
    findFiles: async () => [{ scheme: "file", fsPath: path.join(WS, "src", "app.py") }],
  },
  commands: {
    registerCommand: (name: string, cb: Handler) => ((registered.commands[name] = cb), disposable),
    executeCommand: async (name: string) => void calls.executed.push(name),
  },
};

const Module = require("node:module");
const realLoad = Module._load;
Module._load = function (request: string, ...rest: unknown[]) {
  return request === "vscode" ? fakeVscode : realLoad.call(this, request, ...rest);
};
const extension = require("../extension") as typeof import("../extension");
Module._load = realLoad;

const realFetch = globalThis.fetch;
let nextReply: () => Response | Promise<Response> = () => new Response("{}", { status: 500 });
// Model-info lookups (GET /v1/model-info) are counted apart from chat requests (POST /v1/chat).
let nextModelInfo: () => Response | Promise<Response> = () =>
  new Response(JSON.stringify({ provider: "Ollama", model: "qwen2.5-coder:7b" }), { status: 200 });
globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  if (String(url).endsWith("/v1/model-info")) {
    calls.modelInfo++;
    return nextModelInfo();
  }
  calls.fetch.push(JSON.parse(String(init?.body)));
  return nextReply();
}) as typeof fetch;
const reply = (text: string) => () => new Response(JSON.stringify({ request_id: "r", reply: text }), { status: 200 });

extension.activate({ subscriptions: [] } as any);

const ask = (text: string) => ({ type: "ask", text, useContext: false });
const replies = (v: FakeView) => v.posted.filter((m) => m.type === "reply" || m.type === "error").map((m) => `${m.type}:${m.text}`);

function resolve(): FakeView {
  const v = makeView();
  registered.provider.resolveWebviewView(v.api);
  return v;
}

test("the provider is registered for the manifest view id and retains hidden state", () => {
  assert.equal(registered.id, extension.CHAT_VIEW_ID);
  assert.equal(registered.options.webviewOptions.retainContextWhenHidden, true);
});

test("Ask focuses the sidebar and opens no editor panel", async () => {
  calls.executed.length = 0;
  await registered.commands["riseAssistant.ask"]();
  assert.deepEqual(calls.executed, [`${extension.CHAT_VIEW_ID}.focus`]);
});

test("replies and errors produced while the view is hidden are replayed once, in order, when it is shown", async () => {
  const v = resolve();
  await tick();
  v.hide();
  nextReply = reply("R1");
  await v.send(ask("one"));
  nextReply = reply("R2");
  await v.send(ask("two"));
  nextReply = () => Promise.reject(new TypeError("fetch failed"));
  await v.send(ask("three"));
  await tick();
  assert.deepEqual(replies(v), [], "nothing delivered while hidden");
  await v.show();
  await v.show();
  assert.deepEqual(replies(v), ["reply:R1", "reply:R2", "error:Cannot reach backend at http://127.0.0.1:8765. Is it running?"]);
  v.dispose();
});

test("a view replaced while hidden never receives its old queued messages", async () => {
  const a = resolve();
  await tick();
  a.hide();
  nextReply = reply("OLD");
  await a.send(ask("q"));
  const b = resolve(); // replacement resolves before the old view is disposed
  await tick();
  await a.show();
  a.dispose();
  assert.deepEqual(replies(a), []);
  assert.deepEqual(replies(b), []);
  b.dispose();
});

test("a stale view cannot start backend requests, nor touch the chat, nor use attachment commands", async () => {
  const stale = resolve();
  const current = resolve(); // replacement before disposal: `stale` is still alive and still sending
  await tick();
  calls.fetch.length = 0;
  calls.inputBox = calls.quickPick = 0;
  const before = current.posted.length;
  nextReply = reply("SHOULD NOT HAPPEN");

  await stale.send(ask("from the old view"));
  await stale.send({ type: "attachFile" });
  await stale.send({ type: "clearAttachment" });
  await tick();

  assert.equal(calls.fetch.length, 0, "no backend request");
  assert.equal(calls.inputBox + calls.quickPick, 0, "no attach flow");
  assert.equal(current.posted.length, before, "current chat untouched");
  assert.deepEqual(replies(stale), []);
  stale.dispose();
  current.dispose();
});

test("a stale view cannot consume or remove the attachment of the current view", async () => {
  const stale = resolve();
  const current = resolve();
  await tick();
  await current.send({ type: "attachFile" });
  await tick();
  const chip = current.posted.filter((m) => m.type === "attachment").pop();
  assert.match(chip.text, /src\/app\.py/);

  calls.fetch.length = 0;
  await stale.send(ask("steal it"));
  await stale.send({ type: "clearAttachment" });
  assert.equal(calls.fetch.length, 0);

  nextReply = reply("with file");
  await current.send(ask("explain"));
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.fetch[0].tool_results[0].path, "src/app.py");
  assert.match(calls.fetch[0].tool_results[0].text, /return a \+ b/);

  await current.send(ask("again"));
  assert.equal(calls.fetch[1].tool_results, undefined, "consumed exactly once, by the current view");
  stale.dispose();
  current.dispose();
});

test("disposing a replaced view does not clear the current view's attachment", async () => {
  const old = resolve();
  const current = resolve();
  await tick();
  await current.send({ type: "attachFile" });
  old.dispose(); // late disposal of the replaced view
  calls.fetch.length = 0;
  nextReply = reply("ok");
  await current.send(ask("still attached?"));
  assert.equal(calls.fetch[0].tool_results[0].path, "src/app.py");
  current.dispose();
});

test("disposing the current view discards its attachment and queued messages", async () => {
  const v = resolve();
  await tick();
  await v.send({ type: "attachFile" });
  v.hide();
  nextReply = reply("late");
  await v.send(ask("q"));
  v.dispose();
  const next = resolve();
  await tick();
  calls.fetch.length = 0;
  nextReply = reply("fresh");
  await next.send(ask("new view"));
  assert.equal(calls.fetch[0].tool_results, undefined, "attachment did not survive disposal");
  assert.ok(!replies(next).includes("reply:late"));
  next.dispose();
});

// ---- model information line ----

const modelStates = (v: FakeView) => v.posted.filter((m) => m.type === "modelInfo");
const lastModel = (v: FakeView) => modelStates(v).pop();

test("opening the chat view shows the configured provider and model, replacing 'checking'", async () => {
  nextModelInfo = () => new Response(JSON.stringify({ provider: "Ollama", model: "custom:1b" }), { status: 200 });
  const v = resolve();
  await tick();
  assert.deepEqual(lastModel(v), { type: "modelInfo", state: "ok", provider: "Ollama", model: "custom:1b" });
  v.dispose();
});

test("an unreachable backend shows offline and never a previous model", async () => {
  nextModelInfo = () => Promise.reject(new TypeError("fetch failed"));
  const v = resolve();
  await tick();
  assert.deepEqual(lastModel(v), { type: "modelInfo", state: "offline" });
  assert.ok(modelStates(v).every((m) => m.model === undefined), "no model name was ever posted");
  v.dispose();
});

test("showing the view again re-checks: a backend that stopped is no longer shown with an old model", async () => {
  nextModelInfo = () => new Response(JSON.stringify({ provider: "Ollama", model: "qwen2.5-coder:7b" }), { status: 200 });
  const v = resolve();
  await tick();
  assert.equal(lastModel(v).state, "ok");
  nextModelInfo = () => Promise.reject(new TypeError("fetch failed"));
  await v.show();
  await tick();
  assert.deepEqual(lastModel(v), { type: "modelInfo", state: "offline" });
  v.dispose();
});

test("a failed chat request re-checks the model line", async () => {
  nextModelInfo = () => new Response(JSON.stringify({ provider: "Ollama", model: "qwen2.5-coder:7b" }), { status: 200 });
  const v = resolve();
  await tick();
  calls.modelInfo = 0;
  nextReply = () => Promise.reject(new TypeError("fetch failed"));
  nextModelInfo = () => Promise.reject(new TypeError("fetch failed"));
  await v.send(ask("hello"));
  await tick();
  assert.equal(calls.modelInfo, 1);
  assert.deepEqual(lastModel(v), { type: "modelInfo", state: "offline" });
  v.dispose();
});

test("a successful chat request does not ask the backend about the model again", async () => {
  const v = resolve();
  await tick();
  calls.modelInfo = 0;
  nextReply = reply("fine");
  await v.send(ask("hello"));
  await tick();
  assert.equal(calls.modelInfo, 0);
  v.dispose();
});

test("an older, slower model-info answer cannot overwrite a newer one", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  nextModelInfo = async () => {
    await gate;
    return new Response(JSON.stringify({ provider: "Ollama", model: "OLD" }), { status: 200 });
  };
  const v = resolve(); // first lookup is held back
  await tick();
  nextModelInfo = () => new Response(JSON.stringify({ provider: "Ollama", model: "NEW" }), { status: 200 });
  await v.show(); // second lookup finishes first
  await tick();
  release();
  await tick();
  await tick();
  assert.equal(lastModel(v).model, "NEW");
  assert.ok(modelStates(v).every((m) => m.model !== "OLD"));
  v.dispose();
});

test("model lookups use no chat endpoint and send no editor or file content", async () => {
  nextModelInfo = () => new Response(JSON.stringify({ provider: "Ollama", model: "qwen2.5-coder:7b" }), { status: 200 });
  calls.fetch.length = 0;
  const v = resolve();
  await tick();
  assert.equal(calls.fetch.length, 0, "no POST /v1/chat is made to learn the model name");
  v.dispose();
});

test.after(() => {
  globalThis.fetch = realFetch;
});
