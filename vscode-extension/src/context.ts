// Extracts editor context to send with a question. Pure logic over structural types so it can be
// tested without the vscode module. Reads only the given in-memory document; never other files.
import * as fs from "fs";
import * as path from "path";

export const MAX_CONTEXT_CHARS = 16000;

export interface EditorContextPayload {
  kind: "selection" | "file";
  path: string;
  language?: string;
  start_line: number;
  end_line: number;
  text: string;
}

export interface SelectionLike {
  isEmpty: boolean;
  start: { line: number };
  end: { line: number; character: number };
}

export interface EditorLike {
  document: {
    uri: { scheme: string; fsPath: string };
    languageId: string;
    getText(range?: SelectionLike): string;
  };
  selection: SelectionLike;
}

export interface FolderLike {
  name: string;
  fsPath: string;
}

export type ContextResult =
  | { ok: true; context: EditorContextPayload; summary: string }
  | { ok: false; message: string };

const HINT = "Uncheck \"Include editor context\" to ask without it.";
const fail = (message: string): ContextResult => ({ ok: false, message: `${message} ${HINT}` });

const SENSITIVE_NAMES = /^(\.env(\..*)?|id_(rsa|dsa|ecdsa|ed25519)(_.*)?|.*\.(pem|key|ppk|p12|pfx))$/i;
const PRIVATE_KEY_TEXT = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

function isSensitivePath(p: string): boolean {
  const parts = p.split(/[\\/]/);
  if (parts.includes(".ssh")) {
    return !/\.pub$/i.test(parts[parts.length - 1]);
  }
  return SENSITIVE_NAMES.test(parts[parts.length - 1]);
}

function relativeInside(root: string, target: string): string | undefined {
  const rel = path.relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    return undefined;
  }
  return rel;
}

/**
 * Chooses which editor the context comes from. The webview takes focus, which makes the active
 * editor undefined, so the most recent editor of ANY kind is remembered. It is never limited to
 * supported editors: if the user moved to a git:/output/untitled editor, context must fail
 * rather than silently fall back to an earlier file.
 */
export class EditorTracker<E> {
  private last: E | undefined;

  setActive(editor: E | undefined): void {
    if (editor) {
      this.last = editor;
    }
  }

  pick(active: E | undefined, visible: readonly E[]): E | undefined {
    if (active) {
      this.last = active;
      return active;
    }
    return this.last !== undefined && visible.includes(this.last) ? this.last : undefined;
  }
}

export function extractContext(
  editor: EditorLike | undefined,
  folders: FolderLike[],
  realpath: (p: string) => string = fs.realpathSync
): ContextResult {
  if (!editor) {
    return fail("No active editor file to use as context.");
  }
  const doc = editor.document;
  if (doc.uri.scheme !== "file") {
    return fail("The active editor is not a saved workspace file (untitled and virtual documents are not supported).");
  }
  if (folders.length === 0) {
    return fail("No workspace folder is open.");
  }

  let realFile: string;
  try {
    realFile = realpath(doc.uri.fsPath);
  } catch {
    return fail("Cannot resolve the active file's path.");
  }

  let rel: string | undefined;
  let folder: FolderLike | undefined;
  for (const f of folders) {
    let realRoot: string;
    try {
      realRoot = realpath(f.fsPath);
    } catch {
      continue;
    }
    rel = relativeInside(realRoot, realFile);
    if (rel !== undefined) {
      folder = f;
      break;
    }
  }
  if (rel === undefined || !folder) {
    return fail("The active file is outside the open workspace.");
  }

  if (isSensitivePath(doc.uri.fsPath) || isSensitivePath(realFile)) {
    return fail(`"${path.basename(doc.uri.fsPath)}" looks like a secrets or key file and is never sent.`);
  }
  const fullText = doc.getText();
  if (PRIVATE_KEY_TEXT.test(fullText)) {
    return fail("The file contains a private key and is never sent.");
  }

  const sel = editor.selection;
  const useSelection = !sel.isEmpty;
  const kind = useSelection ? "selection" : "file";
  const text = useSelection ? doc.getText(sel) : fullText;

  if (text.includes("\0")) {
    return fail("The active file looks binary and is not supported.");
  }
  if (!text.trim()) {
    return fail(`The ${kind} is empty.`);
  }
  if (text.length > MAX_CONTEXT_CHARS) {
    const advice = useSelection ? "Select a smaller region." : "Select the relevant function or lines to send just that part.";
    return fail(
      `The ${kind} is ${text.length.toLocaleString("en-US")} characters (limit ${MAX_CONTEXT_CHARS.toLocaleString("en-US")}). ${advice}`
    );
  }

  let startLine = 1;
  let endLine: number;
  if (useSelection) {
    startLine = sel.start.line + 1;
    endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
  } else {
    endLine = Math.max(1, text.replace(/\r?\n$/, "").split(/\r?\n/).length);
  }

  let displayPath = rel.split(path.sep).join("/");
  if (folders.length > 1) {
    displayPath = `${folder.name}/${displayPath}`;
  }
  const language = /^[A-Za-z0-9_+.-]{1,50}$/.test(doc.languageId) ? doc.languageId : undefined;

  return {
    ok: true,
    context: { kind, path: displayPath, ...(language ? { language } : {}), start_line: startLine, end_line: endLine, text },
    summary: `${kind} · ${displayPath}:${startLine}–${endLine} · ${text.length.toLocaleString("en-US")} chars`,
  };
}
