import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EditorLike, EditorTracker, MAX_CONTEXT_CHARS, SelectionLike, extractContext } from "../context";

const WS = "/ws";
const identity = (p: string) => p;
const folders = [{ name: "proj", fsPath: WS }];

const sel = (sl: number, sc: number, el: number, ec: number): SelectionLike => ({
  isEmpty: sl === el && sc === ec,
  start: { line: sl },
  end: { line: el, character: ec },
});
const EMPTY = sel(0, 0, 0, 0);

function editor(opts: {
  text: string;
  fsPath?: string;
  scheme?: string;
  selection?: SelectionLike;
  selected?: string;
  languageId?: string;
}): EditorLike {
  return {
    document: {
      uri: { scheme: opts.scheme ?? "file", fsPath: opts.fsPath ?? "/ws/src/app.py" },
      languageId: opts.languageId ?? "python",
      getText: (range?: SelectionLike) => (range ? opts.selected ?? opts.text : opts.text),
    },
    selection: opts.selection ?? EMPTY,
  };
}

function ok(r: ReturnType<typeof extractContext>) {
  assert.equal(r.ok, true, r.ok ? "" : r.message);
  if (!r.ok) { throw new Error("unreachable"); }
  return r;
}
function bad(r: ReturnType<typeof extractContext>, re: RegExp) {
  assert.equal(r.ok, false);
  if (r.ok) { throw new Error("unreachable"); }
  assert.match(r.message, re);
  assert.match(r.message, /Uncheck "Include editor context"/);
}

test("selection: text, 1-based lines, relative posix path, language", () => {
  const r = ok(extractContext(editor({ text: "full file", selection: sel(9, 4, 11, 7), selected: "def add" }), folders, identity));
  assert.deepEqual(r.context, {
    kind: "selection", path: "src/app.py", language: "python", start_line: 10, end_line: 12, text: "def add",
  });
  assert.match(r.summary, /selection · src\/app\.py:10–12 · 7 chars/);
});

test("selection ending at column 0 does not include the next line", () => {
  const r = ok(extractContext(editor({ text: "x", selection: sel(2, 0, 5, 0), selected: "a\nb\nc\n" }), folders, identity));
  assert.equal(r.context.start_line, 3);
  assert.equal(r.context.end_line, 5);
});

test("no selection falls back to whole file with line count", () => {
  const r = ok(extractContext(editor({ text: "a\nb\nc\n" }), folders, identity));
  assert.equal(r.context.kind, "file");
  assert.equal(r.context.text, "a\nb\nc\n");
  assert.deepEqual([r.context.start_line, r.context.end_line], [1, 3]);
  assert.equal(ok(extractContext(editor({ text: "a\r\nb" }), folders, identity)).context.end_line, 2);
});

test("no editor, non-file scheme, no workspace", () => {
  bad(extractContext(undefined, folders, identity), /No active editor/);
  bad(extractContext(editor({ text: "x", scheme: "untitled" }), folders, identity), /not a saved workspace file/);
  bad(extractContext(editor({ text: "x", scheme: "git" }), folders, identity), /not a saved workspace file/);
  bad(extractContext(editor({ text: "x" }), [], identity), /No workspace folder/);
});

test("files outside the workspace are rejected, including sibling-prefix paths", () => {
  bad(extractContext(editor({ text: "x", fsPath: "/etc/hosts" }), folders, identity), /outside the open workspace/);
  bad(extractContext(editor({ text: "x", fsPath: "/ws-evil/a.py" }), folders, identity), /outside the open workspace/);
  bad(extractContext(editor({ text: "x", fsPath: "/ws/../etc/a.py" }), folders, identity), /outside the open workspace/);
  bad(extractContext(editor({ text: "x", fsPath: "/ws" }), folders, identity), /outside the open workspace/);
});

test("a symlink inside the workspace pointing outside is rejected (real filesystem)", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rise-ctx-"));
  try {
    const root = path.join(base, "ws");
    const outside = path.join(base, "outside.py");
    fs.mkdirSync(root);
    fs.writeFileSync(outside, "print('secret')");
    fs.writeFileSync(path.join(root, "ok.py"), "print('ok')");
    fs.symlinkSync(outside, path.join(root, "link.py"));
    const f = [{ name: "ws", fsPath: root }];
    bad(extractContext(editor({ text: "x", fsPath: path.join(root, "link.py") }), f), /outside the open workspace/);
    ok(extractContext(editor({ text: "print('ok')", fsPath: path.join(root, "ok.py") }), f));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("secret and key files are blocked", () => {
  for (const name of [".env", ".env.local", ".env.production", ".ENV", "server.pem", "tls.key", "id_rsa", "id_ed25519", "id_ecdsa_old", "putty.ppk", "store.p12"]) {
    bad(extractContext(editor({ text: "x", fsPath: `/ws/${name}` }), folders, identity), /never sent/);
  }
  bad(extractContext(editor({ text: "x", fsPath: "/ws/.ssh/config" }), folders, identity), /never sent/);
  ok(extractContext(editor({ text: "x", fsPath: "/ws/.ssh/id_rsa.pub" }), folders, identity));
  ok(extractContext(editor({ text: "x", fsPath: "/ws/environment.py" }), folders, identity));
});

test("private key contents are blocked even with an innocent filename", () => {
  const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";
  bad(extractContext(editor({ text: key, fsPath: "/ws/notes.txt" }), folders, identity), /private key/);
  bad(extractContext(editor({ text: `x\n${key}`, fsPath: "/ws/a.py", selection: sel(0, 0, 0, 1), selected: "x" }), folders, identity), /private key/);
});

test("secret file reached through a symlink is blocked by its real name", () => {
  const real = (p: string) => (p === "/ws/config.txt" ? "/ws/.env" : p);
  bad(extractContext(editor({ text: "x", fsPath: "/ws/config.txt" }), folders, real), /never sent/);
});

test("binary, empty and whitespace-only content are rejected", () => {
  bad(extractContext(editor({ text: "ab\0cd" }), folders, identity), /binary/);
  bad(extractContext(editor({ text: "" }), folders, identity), /empty/);
  bad(extractContext(editor({ text: " \n " }), folders, identity), /empty/);
});

test("size limit: exact max passes, one over is refused with guidance, never clipped", () => {
  ok(extractContext(editor({ text: "a".repeat(MAX_CONTEXT_CHARS) }), folders, identity));
  bad(extractContext(editor({ text: "a".repeat(MAX_CONTEXT_CHARS + 1) }), folders, identity), /file is 16,001 characters \(limit 16,000\).*Select the relevant/);
  const s = extractContext(
    editor({ text: "x", selection: sel(0, 0, 9, 0), selected: "a".repeat(23400) }), folders, identity);
  bad(s, /selection is 23,400 characters \(limit 16,000\)\. Select a smaller region/);
});

test("multi-root workspaces prefix the folder name", () => {
  const two = [{ name: "a", fsPath: "/wa" }, { name: "b", fsPath: "/wb" }];
  const r = ok(extractContext(editor({ text: "x", fsPath: "/wb/lib/x.py" }), two, identity));
  assert.equal(r.context.path, "b/lib/x.py");
});

test("unsafe language ids are dropped", () => {
  const r = ok(extractContext(editor({ text: "x", languageId: "weird lang!" }), folders, identity));
  assert.equal("language" in r.context, false);
});

// -- Stale editor regression ------------------------------------------------------------------

test("an unsupported active editor (git:) never falls back to the previous file", () => {
  const file = editor({ text: "secret = 1", fsPath: "/ws/src/app.py" });
  const git = editor({ text: "old version", scheme: "git", fsPath: "/ws/src/app.py" });
  const tracker = new EditorTracker<EditorLike>();

  tracker.setActive(file);
  ok(extractContext(tracker.pick(file, [file, git]), folders, identity)); // sanity: valid file works

  tracker.setActive(git); // user opens a git: diff editor
  // (a) git editor reported as active
  bad(extractContext(tracker.pick(git, [file, git]), folders, identity), /not a saved workspace file/);
  // (b) webview has focus, so no active editor: the remembered one is the git editor, not the file
  bad(extractContext(tracker.pick(undefined, [file, git]), folders, identity), /not a saved workspace file/);
});

test("untitled and output editors also replace the previous file", () => {
  for (const scheme of ["untitled", "output", "vscode-terminal"]) {
    const file = editor({ text: "a = 1" });
    const other = editor({ text: "b = 2", scheme, fsPath: "/ws/other" });
    const tracker = new EditorTracker<EditorLike>();
    tracker.setActive(file);
    tracker.setActive(other);
    bad(extractContext(tracker.pick(undefined, [file, other]), folders, identity), /not a saved workspace file/);
  }
});

test("tracker: webview focus keeps the last valid file; closed editors are not reused", () => {
  const file = editor({ text: "a = 1" });
  const tracker = new EditorTracker<EditorLike>();
  tracker.setActive(file);
  assert.equal(tracker.pick(undefined, [file]), file); // chat has focus, file still visible
  assert.equal(tracker.pick(undefined, []), undefined); // file closed -> no stale context
  bad(extractContext(tracker.pick(undefined, []), folders, identity), /No active editor/);
  assert.equal(tracker.pick(undefined, [file]), file); // still remembered if it becomes visible again
});

test("switching back to a valid file restores context", () => {
  const file = editor({ text: "a = 1" });
  const git = editor({ text: "x", scheme: "git" });
  const tracker = new EditorTracker<EditorLike>();
  tracker.setActive(git);
  tracker.setActive(file);
  ok(extractContext(tracker.pick(undefined, [file, git]), folders, identity));
});
