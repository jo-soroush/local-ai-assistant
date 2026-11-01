// Extension-side workspace tools (C05): search_files and read_file. Read-only, user-initiated.
// The model never calls these; the user picks a file and the extension reads it. The backend only
// receives the resulting text and never opens a path itself.
import * as fs from "fs";
import * as path from "path";
import { FolderLike, MAX_CONTEXT_CHARS, PRIVATE_KEY_TEXT, isSensitivePath, relativeInside } from "./context";

export const MAX_FILE_BYTES = 64 * 1024;
export const MAX_ATTACHED_CHARS = MAX_CONTEXT_CHARS;
export const MAX_SEARCH_RESULTS = 50;
export const MAX_QUERY_CHARS = 100;
export const SEARCH_EXCLUDE = "**/{node_modules,.git,out,dist,.venv,__pycache__}/**";

export type ToolErrorCode =
  | "invalid_path"
  | "invalid_query"
  | "no_workspace"
  | "outside_workspace"
  | "sensitive"
  | "not_found"
  | "not_file"
  | "binary"
  | "not_utf8"
  | "empty"
  | "too_large"
  | "changed"
  | "workspace_changed";

export interface ToolFailure {
  ok: false;
  error: { code: ToolErrorCode; message: string };
}

/** Wire format sent to the backend as `tool_results[]`. */
export interface ReadFilePayload {
  tool: "read_file";
  path: string;
  start_line: number;
  end_line: number;
  text: string;
}

export type ReadFileResult = { ok: true; result: ReadFilePayload; realFile: string } | ToolFailure;
export type SearchFilesResult = { ok: true; files: string[]; truncated: boolean } | ToolFailure;

/** Finds candidate absolute paths for a (validated) query. Supplied by the extension host. */
export type FileFinder = (query: string) => Promise<string[]>;

const fail = (code: ToolErrorCode, message: string): ToolFailure => ({ ok: false, error: { code, message } });

const BLOCKED_DIRS = new Set([".git", ".aws"]);
const BLOCKED_NAMES = new Set([".npmrc", ".netrc", ".pypirc"]);
const QUERY_RE = /^[A-Za-z0-9._\/-]+$/;
const CONTROL_RE = /[\x00-\x1f\x7f]/;

/** C05-only protection on top of the C04 secret-file rules. `parts` are workspace-relative segments. */
function isBlocked(parts: string[]): boolean {
  return parts.some((p) => BLOCKED_DIRS.has(p.toLowerCase())) || BLOCKED_NAMES.has((parts[parts.length - 1] ?? "").toLowerCase());
}

interface Located {
  folder: FolderLike;
  realFile: string;
  rel: string;
  display: string;
}

function display(folder: FolderLike, rel: string, multiRoot: boolean): string {
  const posix = rel.split(path.sep).join("/");
  return multiRoot ? `${folder.name}/${posix}` : posix;
}

/** Resolves a real file path to its workspace folder, or explains why it is not allowed. */
function locate(
  realFile: string,
  requested: string,
  folders: FolderLike[],
  realpath: (p: string) => string,
  multiRoot: boolean
): Located | ToolFailure {
  for (const folder of folders) {
    let realRoot: string;
    try {
      realRoot = realpath(folder.fsPath);
    } catch {
      continue;
    }
    const rel = relativeInside(realRoot, realFile);
    if (rel === undefined) {
      continue;
    }
    if (isBlocked(rel.split(path.sep)) || isSensitivePath(realFile) || isSensitivePath(requested)) {
      return fail("sensitive", `"${path.basename(realFile)}" is a protected file (secrets, keys or credentials) and is never read.`);
    }
    return { folder, realFile, rel, display: display(folder, rel, multiRoot) };
  }
  return fail("outside_workspace", "The file resolves to a location outside the open workspace.");
}

/** Test seams: called at the exact points where a concurrent attacker could change the filesystem. */
export interface ReadDeps {
  realpath?: (p: string) => string;
  beforeOpen?: () => void;
  afterOpen?: () => void;
  afterRead?: () => void;
}

// O_NONBLOCK: opening a FIFO read-only returns at once instead of waiting for a writer.
// O_NOFOLLOW: if the final component was swapped for a symlink after validation, open fails (ELOOP).
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);

export function readFile(requestedPath: unknown, folders: FolderLike[], deps: ReadDeps = {}): ReadFileResult {
  const realpath = deps.realpath ?? fs.realpathSync;
  if (typeof requestedPath !== "string" || requestedPath.length === 0 || requestedPath.length > 500) {
    return fail("invalid_path", "A workspace-relative file path is required.");
  }
  if (CONTROL_RE.test(requestedPath) || requestedPath.includes("\\") || requestedPath.startsWith("/") || /^[A-Za-z]:/.test(requestedPath)) {
    return fail("invalid_path", "The path must be workspace-relative and use '/' separators.");
  }
  let parts = requestedPath.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) {
    return fail("invalid_path", "The path must not contain empty, '.' or '..' segments.");
  }
  if (folders.length === 0) {
    return fail("no_workspace", "No workspace folder is open.");
  }

  let folder = folders[0];
  if (folders.length > 1) {
    const match = folders.find((f) => f.name === parts[0]);
    if (!match || parts.length < 2) {
      return fail("invalid_path", "In a multi-root workspace the path must start with the workspace folder name.");
    }
    folder = match;
    parts = parts.slice(1);
  }
  if (isBlocked(parts) || isSensitivePath(parts.join("/"))) {
    return fail("sensitive", `"${parts[parts.length - 1]}" is a protected file or folder and is never read.`);
  }

  const lexical = path.join(folder.fsPath, ...parts);
  let realFile: string;
  try {
    realFile = realpath(lexical);
  } catch {
    return fail("not_found", `File not found: ${requestedPath}`);
  }
  const located = locate(realFile, lexical, [folder], realpath, folders.length > 1);
  if (!("rel" in located)) {
    return located;
  }
  // Special files (FIFO, device, socket) are never opened at all.
  try {
    if (!fs.lstatSync(realFile).isFile()) {
      return fail("not_file", "The path is not a regular file.");
    }
  } catch {
    return fail("not_found", `File not found: ${requestedPath}`);
  }

  // The checks above ran on a path; an attacker with write access to the workspace can change what that
  // path names before it is opened. Node has no openat(), so authorization is bound to the opened object
  // instead: after open() and again after read(), the descriptor must be the very file (device + inode)
  // that the path resolves to now, and that path must still be the validated real path.
  const sameObject = (fd: number): ToolFailure | undefined => {
    try {
      const now = realpath(lexical);
      if (now !== realFile) {
        const root = realpath(folder.fsPath);
        return relativeInside(root, now) === undefined
          ? fail("outside_workspace", "The file path changed to a location outside the workspace; nothing was read.")
          : fail("changed", "The file path changed while it was being read; nothing was returned.");
      }
      const opened = fs.fstatSync(fd, { bigint: true });
      const named = fs.statSync(realFile, { bigint: true });
      if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) {
        return fail("changed", "The file was replaced while it was being read; nothing was returned.");
      }
    } catch {
      return fail("changed", "The file changed while it was being read; nothing was returned.");
    }
    return undefined;
  };

  let text: string;
  let fd: number | undefined;
  try {
    deps.beforeOpen?.();
    fd = fs.openSync(realFile, OPEN_FLAGS);
    deps.afterOpen?.();
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile()) {
      return fail("not_file", "The path is not a regular file.");
    }
    const raced = sameObject(fd);
    if (raced) {
      return raced;
    }
    if (st.size > BigInt(MAX_FILE_BYTES)) {
      return fail("too_large", `The file is ${st.size.toLocaleString("en-US")} bytes (limit ${MAX_FILE_BYTES.toLocaleString("en-US")}).`);
    }
    const buf = Buffer.alloc(MAX_FILE_BYTES + 1);
    let n = 0;
    for (;;) {
      const r = fs.readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) {
        break;
      }
      n += r;
      if (n > MAX_FILE_BYTES) {
        return fail("too_large", `The file is larger than ${MAX_FILE_BYTES.toLocaleString("en-US")} bytes.`);
      }
    }
    deps.afterRead?.();
    const racedAfter = sameObject(fd);
    if (racedAfter) {
      return racedAfter;
    }
    const bytes = buf.subarray(0, n);
    if (bytes.includes(0)) {
      return fail("binary", "The file looks binary and is not supported.");
    }
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return fail("not_utf8", "The file is not valid UTF-8 text.");
    }
  } catch {
    return fail("not_found", `The file could not be read: ${requestedPath}`);
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }

  if (PRIVATE_KEY_TEXT.test(text)) {
    return fail("sensitive", "The file contains a private key and is never read.");
  }
  if (!text.trim()) {
    return fail("empty", "The file is empty.");
  }
  if (text.length > MAX_ATTACHED_CHARS) {
    return fail(
      "too_large",
      `The file is ${text.length.toLocaleString("en-US")} characters (limit ${MAX_ATTACHED_CHARS.toLocaleString("en-US")}).`
    );
  }
  const lines = Math.max(1, text.replace(/\r?\n$/, "").split(/\r?\n/).length);
  return { ok: true, result: { tool: "read_file", path: located.display, start_line: 1, end_line: lines, text }, realFile };
}

/** Case-insensitive glob for the finder: each letter becomes a [xX] class so matching ignores case. */
export function caseInsensitiveGlob(query: string): string {
  return `**/*${query.replace(/[A-Za-z]/g, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`)}*`;
}

export async function searchFiles(
  query: unknown,
  folders: FolderLike[],
  find: FileFinder,
  realpath: (p: string) => string = fs.realpathSync
): Promise<SearchFilesResult> {
  const q = typeof query === "string" ? query.trim() : "";
  if (!q || q.length > MAX_QUERY_CHARS || !QUERY_RE.test(q) || q.split("/").includes("..")) {
    return fail("invalid_query", `Use 1-${MAX_QUERY_CHARS} characters: letters, digits, '.', '_', '-' or '/'.`);
  }
  if (folders.length === 0) {
    return fail("no_workspace", "No workspace folder is open.");
  }

  const needle = q.toLowerCase();
  const found = new Set<string>();
  for (const candidate of await find(q)) {
    let real: string;
    try {
      real = realpath(candidate);
    } catch {
      continue;
    }
    const located = locate(real, candidate, folders, realpath, folders.length > 1);
    if ("rel" in located && located.display.toLowerCase().includes(needle)) {
      found.add(located.display);
    }
  }
  const files = [...found].sort();
  return { ok: true, files: files.slice(0, MAX_SEARCH_RESULTS), truncated: files.length > MAX_SEARCH_RESULTS };
}

/** The one file the user attached, bound to the exact workspace and file that were selected. */
export interface Attachment {
  path: string;
  realFile: string;
  folders: FolderLike[];
}

const folderKey = (folders: FolderLike[]) => folders.map((f) => `${f.name}\0${f.fsPath}`).sort().join("\n");
export const sameFolders = (a: FolderLike[], b: FolderLike[]) => folderKey(a) === folderKey(b);

export function attachmentFrom(read: Extract<ReadFileResult, { ok: true }>, folders: FolderLike[]): Attachment {
  return { path: read.result.path, realFile: read.realFile, folders: folders.map((f) => ({ ...f })) };
}

/** Re-reads an attachment at send time; it must still be the same file in the same workspace. */
export function rereadAttachment(att: Attachment, current: FolderLike[], deps: ReadDeps = {}): ReadFileResult {
  if (!sameFolders(att.folders, current)) {
    return fail("workspace_changed", "The workspace folders changed since the file was attached.");
  }
  const read = readFile(att.path, current, deps);
  if (read.ok && (read.realFile !== att.realFile || read.result.path !== att.path)) {
    return fail("changed", "The attached path no longer refers to the file you selected.");
  }
  return read;
}

/**
 * Holds the pending attachment. Sending consumes it before any await, so a late reply can never clear
 * a newer attachment; tickets stop an older, slower attach flow from overwriting a newer one.
 */
export class AttachmentStore {
  private seq = 0;
  private current: Attachment | undefined;

  begin(): number {
    return ++this.seq;
  }

  commit(ticket: number, att: Attachment): boolean {
    if (ticket !== this.seq) {
      return false;
    }
    this.current = att;
    return true;
  }

  peek(): Attachment | undefined {
    return this.current;
  }

  take(): Attachment | undefined {
    const a = this.current;
    this.current = undefined;
    return a;
  }

  /** User removal, panel disposal or workspace change: also cancels attach flows still in progress. */
  clear(): void {
    this.seq++;
    this.current = undefined;
  }
}
