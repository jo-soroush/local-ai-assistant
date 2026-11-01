// Regression tests for the C05 audit: filesystem races, FIFOs, attachment lifecycle/identity, case folding.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isSensitivePath } from "../context";
import { AttachmentStore, attachmentFrom, readFile, rereadAttachment, sameFolders, searchFiles } from "../workspace";

const SECRET = "TOP SECRET OUTSIDE CONTENT";
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rise-c05r-")));
const WS = path.join(base, "ws");
const OUT = path.join(base, "outside");
const folders = [{ name: "proj", fsPath: WS }];

function put(rel: string, content: string | Buffer, root = WS): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

function codeOf(r: ReturnType<typeof readFile>): string {
  assert.equal(r.ok, false, "expected a refusal");
  return r.ok ? "" : r.error.code;
}

// An attacker-controlled outside file is never allowed to come back, whatever the race does.
function assertNoLeak(r: ReturnType<typeof readFile>) {
  assert.ok(!JSON.stringify(r).includes(SECRET), "outside content leaked");
}

put("secret.txt", SECRET, OUT);
put("f.txt", SECRET, OUT);

// ---- HIGH 1: replacement between validation and open ----

test("final file swapped for an outside symlink after validation is not followed", () => {
  const file = put("race1.txt", "inside\n");
  const r = readFile("race1.txt", folders, {
    beforeOpen: () => {
      fs.unlinkSync(file);
      fs.symlinkSync(path.join(OUT, "secret.txt"), file);
    },
  });
  assertNoLeak(r);
  assert.equal(r.ok, false);
});

test("parent directory swapped for an outside symlink after validation is detected", () => {
  put("pdir/f.txt", "inside\n");
  const r = readFile("pdir/f.txt", folders, {
    beforeOpen: () => {
      fs.renameSync(path.join(WS, "pdir"), path.join(WS, "pdir_old"));
      fs.symlinkSync(OUT, path.join(WS, "pdir"));
    },
  });
  assertNoLeak(r);
  assert.equal(codeOf(r), "outside_workspace");
});

test("parent swapped to outside for the open and swapped back before the check is detected (fd identity)", () => {
  put("qdir/f.txt", "inside\n");
  const r = readFile("qdir/f.txt", folders, {
    beforeOpen: () => {
      fs.renameSync(path.join(WS, "qdir"), path.join(WS, "qdir_old"));
      fs.symlinkSync(OUT, path.join(WS, "qdir"));
    },
    afterOpen: () => {
      fs.unlinkSync(path.join(WS, "qdir"));
      fs.renameSync(path.join(WS, "qdir_old"), path.join(WS, "qdir"));
    },
  });
  assertNoLeak(r);
  assert.equal(codeOf(r), "changed");
});

test("file replaced by a different file after open is detected", () => {
  const target = put("race3.txt", "original\n");
  const other = put("race3-other.txt", "replacement\n");
  const r = readFile("race3.txt", folders, { afterOpen: () => fs.renameSync(other, target) });
  assert.equal(codeOf(r), "changed");
});

test("path swapped to an outside symlink after the read is detected and nothing is returned", () => {
  const file = put("race4.txt", "inside\n");
  const r = readFile("race4.txt", folders, {
    afterRead: () => {
      fs.unlinkSync(file);
      fs.symlinkSync(path.join(OUT, "secret.txt"), file);
    },
  });
  assertNoLeak(r);
  assert.equal(codeOf(r), "outside_workspace");
});

test("an unchanged file is still read normally", () => {
  put("calm.txt", "calm\n");
  const r = readFile("calm.txt", folders, { beforeOpen: () => {}, afterOpen: () => {}, afterRead: () => {} });
  assert.equal(r.ok && r.result.text, "calm\n");
});

// ---- HIGH 2: FIFOs ----

function mkfifo(p: string): boolean {
  try {
    execFileSync("mkfifo", [p]);
    return true;
  } catch {
    return false;
  }
}

// Run in a child process with a hard timeout so a blocking open() fails the test instead of hanging it.
function probe(mode: "direct" | "swap"): { code?: string; timedOut: boolean } {
  const dir = fs.mkdtempSync(path.join(base, "fifo-"));
  if (mode === "direct") {
    if (!mkfifo(path.join(dir, "pipe"))) {
      return { code: "unsupported", timedOut: false };
    }
  } else {
    fs.writeFileSync(path.join(dir, "pipe"), "regular\n");
  }
  const script = `
    const fs = require("fs"); const cp = require("child_process"); const path = require("path");
    const { readFile } = require(process.argv[1]);
    const dir = process.argv[2];
    const deps = process.argv[3] === "swap"
      ? { beforeOpen: () => { fs.unlinkSync(path.join(dir, "pipe")); cp.execFileSync("mkfifo", [path.join(dir, "pipe")]); } }
      : {};
    const r = readFile("pipe", [{ name: "p", fsPath: dir }], deps);
    console.log(r.ok ? "ok" : r.error.code);
  `;
  const res = spawnSync(process.execPath, ["-e", script, path.join(__dirname, "..", "workspace.js"), dir, mode], {
    timeout: 8000,
    encoding: "utf8",
  });
  return { code: res.stdout.trim(), timedOut: (res.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" };
}

test("a real FIFO in the workspace is refused without blocking", () => {
  const r = probe("direct");
  assert.equal(r.timedOut, false, "readFile blocked on a FIFO");
  if (r.code === "unsupported") { return; }
  assert.equal(r.code, "not_file");
});

test("a file swapped for a FIFO right before open() does not block", () => {
  const r = probe("swap");
  assert.equal(r.timedOut, false, "open() blocked on a FIFO");
  assert.equal(r.code, "not_file");
});

// ---- MEDIUM 3: attachment lifecycle ----

const A = { path: "a.txt", realFile: "/x/a.txt", folders };
const B = { path: "b.txt", realFile: "/x/b.txt", folders };

test("a slower, older attach flow cannot overwrite a newer attachment", () => {
  const s = new AttachmentStore();
  const t1 = s.begin();
  const t2 = s.begin();
  assert.equal(s.commit(t2, B), true);
  assert.equal(s.commit(t1, A), false);
  assert.equal(s.peek(), B);
});

test("overlapping sends: the attachment is consumed once, by the first send", () => {
  const s = new AttachmentStore();
  s.commit(s.begin(), A);
  assert.equal(s.take(), A);
  assert.equal(s.take(), undefined);
});

test("a new attachment chosen while an earlier send is in flight survives that send finishing", () => {
  const s = new AttachmentStore();
  s.commit(s.begin(), A);
  s.take(); // send 1 dispatches; consumption happens before its await
  s.commit(s.begin(), B); // user attaches another file while send 1 is pending
  // send 1's reply arrives: nothing in the reply path touches the store
  assert.equal(s.peek(), B);
});

test("replacement and removal", () => {
  const s = new AttachmentStore();
  s.commit(s.begin(), A);
  s.commit(s.begin(), B);
  assert.equal(s.peek(), B);
  s.clear();
  assert.equal(s.peek(), undefined);
});

test("removal or disposal cancels an attach flow that is still choosing a file", () => {
  const s = new AttachmentStore();
  const ticket = s.begin();
  s.clear(); // panel disposed / user removed / workspace changed
  assert.equal(s.commit(ticket, A), false);
  assert.equal(s.peek(), undefined);
});

// ---- MEDIUM 4: workspace identity ----

put("proj2/src/app.py", "WRONG PROJECT\n", base);
put("swap/a.txt", "A\n");
put("swap/b.txt", "B\n");
put("src/app.py", "right project\n");

function attach(p: string, fs_ = folders) {
  const r = readFile(p, fs_);
  assert.equal(r.ok, true);
  if (!r.ok) { throw new Error("unreachable"); }
  return attachmentFrom(r, fs_);
}

test("an attachment re-reads fine while the workspace is unchanged", () => {
  const r = rereadAttachment(attach("src/app.py"), folders);
  assert.equal(r.ok && r.result.text, "right project\n");
});

test("replacing the workspace folder invalidates the attachment instead of reading the same relative path elsewhere", () => {
  const att = attach("src/app.py");
  const replaced = [{ name: "proj", fsPath: path.join(base, "proj2") }];
  const r = rereadAttachment(att, replaced);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.error.code === "workspace_changed");
  assert.ok(!JSON.stringify(r).includes("WRONG PROJECT"));
});

test("a path retargeted to a different in-workspace file invalidates the attachment", () => {
  const att = attach("swap/a.txt");
  fs.unlinkSync(path.join(WS, "swap/a.txt"));
  fs.symlinkSync(path.join(WS, "swap/b.txt"), path.join(WS, "swap/a.txt"));
  const r = rereadAttachment(att, folders);
  assert.ok(!r.ok && r.error.code === "changed");
});

test("multi-root: removing, renaming or adding a root invalidates; reordering does not", () => {
  const roots = [{ name: "proj", fsPath: WS }, { name: "other", fsPath: OUT }];
  const att = attach("other/secret.txt", roots);
  assert.equal(att.path, "other/secret.txt");
  assert.equal(rereadAttachment(att, roots).ok, true);
  assert.equal(rereadAttachment(att, [...roots].reverse()).ok, true);
  for (const changed of [
    [roots[0]],
    [roots[0], { name: "renamed", fsPath: OUT }],
    [...roots, { name: "third", fsPath: path.join(base, "proj2") }],
    [roots[0], { name: "other", fsPath: path.join(base, "proj2") }],
  ]) {
    const r = rereadAttachment(att, changed);
    assert.ok(!r.ok && r.error.code === "workspace_changed");
  }
  assert.equal(sameFolders(roots, [...roots].reverse()), true);
});

// ---- MEDIUM 5: case-insensitive protection ----

test("sensitive directory and file names are matched case-insensitively", () => {
  for (const p of [
    "/ws/.ssh/config", "/ws/.SSH/config", "/ws/.Ssh/id", "/ws/a/.sSh/known_hosts", "/ws/.ENV", "/ws/.Env.local",
    "/ws/ID_RSA", "/ws/Id_Ed25519", "/ws/k/SERVER.PEM", "/ws/x.KEY", "/ws/x.P12",
  ]) {
    assert.equal(isSensitivePath(p), true, p);
  }
  assert.equal(isSensitivePath("/ws/.SSH/id_rsa.PUB"), false); // public keys stay allowed, as before
  assert.equal(isSensitivePath("/ws/src/app.py"), false);
});

test("read_file refuses mixed-case protected paths, even where the filesystem ignores case", () => {
  put(".SSH/config.txt", "Host x\n");
  for (const p of [
    ".SSH/config.txt", ".Ssh/key", ".GIT/config", ".Git/HEAD", ".AWS/credentials", ".Aws/config", ".NPMRC", ".NetRC", ".PyPiRC",
    ".ENV", ".Env.Production", "ID_RSA", "keys/SERVER.PEM", "keys/Tls.Key",
  ]) {
    assert.equal(codeOf(readFile(p, folders)), "sensitive", p);
  }
});

test("search_files hides mixed-case protected files", async () => {
  const hostile = [".SSH/config.txt", ".GIT/config", ".AWS/credentials", ".NPMRC", ".ENV", "ID_RSA", "keys/SERVER.PEM"].map((p) => path.join(WS, p));
  for (const q of ["config", "credentials", "npmrc", "env", "id_rsa", "server"]) {
    const r = await searchFiles(q, folders, async () => hostile);
    assert.deepEqual(r.ok && r.files, [], q);
  }
});
