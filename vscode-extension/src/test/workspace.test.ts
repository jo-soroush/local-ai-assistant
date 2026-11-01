import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_FILE_BYTES, MAX_SEARCH_RESULTS, caseInsensitiveGlob, readFile, searchFiles } from "../workspace";

// Real temp directories and real symlinks, so the boundary checks run against the actual filesystem.
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rise-c05-")));
const WS = path.join(base, "ws");
const OUT = path.join(base, "outside");
const folders = [{ name: "proj", fsPath: WS }];

function put(rel: string, content: string | Buffer, root = WS): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

put("src/app.py", "def add(a, b):\n    return a + b\n");
put("src/Config.py", "PORT = 8765\n");
put("README.md", "# hi\n");
put(".env", "SECRET=1\n");
put(".git/config", "[remote]\n");
put(".npmrc", "//registry/:_authToken=x\n");
put(".aws/credentials", "[default]\n");
put("id_rsa", "x");
put("keys/server.pem", "x");
put("node_modules/lib/index.js", "x");
put("secret_note.txt", "-----BEGIN RSA PRIVATE KEY-----\nabc\n");
put("bin.dat", Buffer.from([0x61, 0x00, 0x62]));
put("bad.txt", Buffer.from([0xff, 0xfe, 0xfd]));
put("big.txt", "a".repeat(MAX_FILE_BYTES + 1));
put("chars.txt", "a".repeat(16001));
put("empty.txt", "  \n");
put("secret.txt", "TOP SECRET", OUT);
fs.symlinkSync(path.join(OUT, "secret.txt"), path.join(WS, "link-file.txt"));
fs.symlinkSync(OUT, path.join(WS, "link-dir"));
fs.symlinkSync(path.join(WS, "src/app.py"), path.join(WS, "inside-link.py"));
fs.mkdirSync(path.join(WS, "adir"));

function code(r: { ok: boolean; error?: { code: string } }): string | undefined {
  return r.ok ? undefined : r.error?.code;
}

test("read_file returns an allowed file", () => {
  const r = readFile("src/app.py", folders);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.result, {
      tool: "read_file",
      path: "src/app.py",
      start_line: 1,
      end_line: 2,
      text: "def add(a, b):\n    return a + b\n",
    });
  }
});

test("read_file follows a symlink that stays inside the workspace and reports the real path", () => {
  const r = readFile("inside-link.py", folders);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.result.path, "src/app.py");
  }
});

for (const bad of ["../outside/secret.txt", "src/../../outside/secret.txt", "/etc/passwd", "C:/Windows/x", "src\\app.py", "src//app.py", "./src/app.py", "src/app.py\0", "", "src/.."]) {
  test(`read_file rejects invalid path ${JSON.stringify(bad)}`, () => {
    assert.equal(code(readFile(bad, folders)), "invalid_path");
  });
}

test("read_file rejects non-string paths", () => {
  for (const v of [undefined, null, 5, {}, ["src/app.py"]]) {
    assert.equal(code(readFile(v, folders)), "invalid_path");
  }
});

test("read_file blocks a symlinked file that points outside the workspace", () => {
  assert.equal(code(readFile("link-file.txt", folders)), "outside_workspace");
});

test("read_file blocks files reached through a symlinked directory outside the workspace", () => {
  assert.equal(code(readFile("link-dir/secret.txt", folders)), "outside_workspace");
});

test("read_file reports a missing file and a directory", () => {
  assert.equal(code(readFile("nope.py", folders)), "not_found");
  assert.equal(code(readFile("adir", folders)), "not_file");
});

test("read_file refuses secret, credential and .git files", () => {
  for (const p of [".env", ".git/config", ".npmrc", ".aws/credentials", "id_rsa", "keys/server.pem"]) {
    assert.equal(code(readFile(p, folders)), "sensitive", p);
  }
  assert.equal(code(readFile("secret_note.txt", folders)), "sensitive");
});

test("read_file refuses binary, non-UTF-8, empty and oversized files", () => {
  assert.equal(code(readFile("bin.dat", folders)), "binary");
  assert.equal(code(readFile("bad.txt", folders)), "not_utf8");
  assert.equal(code(readFile("empty.txt", folders)), "empty");
  assert.equal(code(readFile("big.txt", folders)), "too_large");
  assert.equal(code(readFile("chars.txt", folders)), "too_large");
});

test("read_file with no workspace folder fails", () => {
  assert.equal(code(readFile("src/app.py", [])), "no_workspace");
});

test("multi-root: paths carry the folder name and cannot cross into another root", () => {
  const two = [...folders, { name: "other", fsPath: OUT }];
  const ok = readFile("other/secret.txt", two);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.result.path, "other/secret.txt");
  }
  assert.equal(code(readFile("src/app.py", two)), "invalid_path");
  assert.equal(code(readFile("proj/link-file.txt", two)), "outside_workspace");
});

const finder = (paths: string[]) => async () => paths;

test("search_files lists matching files with workspace-relative paths", async () => {
  const r = await searchFiles("config", folders, finder([path.join(WS, "src/Config.py"), path.join(WS, "src/app.py")]));
  assert.deepEqual(r.ok && r.files, ["src/Config.py"]);
});

test("search_files hides secrets, .git, symlink escapes and missing paths even if the finder returns them", async () => {
  const hostile = [
    ".env", ".git/config", ".npmrc", ".aws/credentials", "id_rsa", "keys/server.pem", "link-file.txt", "link-dir/secret.txt",
  ].map((p) => path.join(WS, p));
  hostile.push(path.join(OUT, "secret.txt"), path.join(WS, "ghost.txt"), "/etc/passwd");
  for (const q of ["env", "git", "npmrc", "credentials", "id_rsa", "pem", "link", "secret", "ghost", "passwd"]) {
    const r = await searchFiles(q, folders, finder(hostile));
    assert.deepEqual(r.ok && r.files, [], q);
  }
});

test("search_files rejects bad queries without calling the finder", async () => {
  let called = false;
  const find = async () => { called = true; return []; };
  for (const q of ["", "   ", "a*b", "**", "../x", "a b", "x".repeat(101), undefined, 5, "{a,b}", "a\0b"]) {
    const r = await searchFiles(q, folders, find);
    assert.equal(code(r), "invalid_query", String(q));
  }
  assert.equal(called, false);
  assert.equal(code(await searchFiles("x", [], find)), "no_workspace");
});

test("search_files caps results and reports truncation", async () => {
  const many: string[] = [];
  for (let i = 0; i < MAX_SEARCH_RESULTS + 5; i++) {
    many.push(put(`many/f${String(i).padStart(3, "0")}.txt`, "x"));
  }
  const r = await searchFiles("f0", folders, finder(many));
  assert.equal(r.ok && r.files.length, MAX_SEARCH_RESULTS);
  assert.equal(r.ok && r.truncated, true);
});

test("caseInsensitiveGlob builds a letter-class glob", () => {
  assert.equal(caseInsensitiveGlob("a.b"), "**/*[aA].[bB]*");
});

test("search then read workflow: discover a file and read it", async () => {
  const found = await searchFiles("config", folders, finder([path.join(WS, "src/Config.py")]));
  assert.equal(found.ok, true);
  if (!found.ok) { return; }
  const read = readFile(found.files[0], folders);
  assert.equal(read.ok, true);
  if (read.ok) {
    assert.equal(read.result.text, "PORT = 8765\n");
  }
});
