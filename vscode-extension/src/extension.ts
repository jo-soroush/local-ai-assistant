import * as crypto from "crypto";
import * as vscode from "vscode";
import { BackendError, DEFAULT_BACKEND_URL, DEFAULT_TIMEOUT_MS, postChat } from "./client";
import { ContextResult, EditorTracker, extractContext } from "./context";
import { getWebviewHtml } from "./webview";
import {
  Attachment,
  AttachmentStore,
  MAX_SEARCH_RESULTS,
  SEARCH_EXCLUDE,
  attachmentFrom,
  caseInsensitiveGlob,
  readFile,
  rereadAttachment,
  sameFolders,
  searchFiles,
} from "./workspace";

let panel: vscode.WebviewPanel | undefined;
const tracker = new EditorTracker<vscode.TextEditor>();

// The one workspace file the user attached; it is re-read (and re-checked) when the message is sent.
const attachments = new AttachmentStore();

function workspaceFolders() {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => ({ name: f.name, fsPath: f.uri.fsPath }));
}

function currentContext(): ContextResult {
  const editor = tracker.pick(vscode.window.activeTextEditor, vscode.window.visibleTextEditors);
  return extractContext(editor, workspaceFolders());
}

function showAttachment(att: Attachment | undefined, summary = ""): void {
  void panel?.webview.postMessage({ type: "attachment", text: att ? summary : "" });
}

function dropAttachment(reason?: string): void {
  attachments.clear();
  showAttachment(undefined);
  if (reason) {
    void panel?.webview.postMessage({ type: "error", text: reason });
  }
}

async function findCandidates(query: string): Promise<string[]> {
  const uris = await vscode.workspace.findFiles(caseInsensitiveGlob(query), SEARCH_EXCLUDE, 500);
  return uris.filter((u) => u.scheme === "file").map((u) => u.fsPath);
}

/** search_files then read_file, both initiated by the user: they type the query and pick the file. */
async function attachWorkspaceFile(): Promise<void> {
  const target = panel;
  const ticket = attachments.begin();
  const folders = workspaceFolders();
  const fail = (text: string) => void target?.webview.postMessage({ type: "error", text });
  // Anything that happened while a picker was open (panel closed, workspace changed, newer attach) cancels this one.
  const stale = () => panel !== target || !sameFolders(folders, workspaceFolders());
  const query = await vscode.window.showInputBox({
    title: "Attach workspace file",
    prompt: "Search file names in the open workspace (read-only; the file is sent to the local model).",
    placeHolder: "e.g. config.py",
  });
  if (query === undefined || stale()) {
    return;
  }
  const found = await searchFiles(query, folders, findCandidates);
  if (!found.ok) {
    fail(found.error.message);
    return;
  }
  if (found.files.length === 0) {
    fail(`No readable workspace files match "${query.trim()}".`);
    return;
  }
  const picked = await vscode.window.showQuickPick(found.files, {
    title: found.truncated ? `Showing the first ${MAX_SEARCH_RESULTS} matches; refine the search for more` : "Select a file to attach",
  });
  if (picked === undefined) {
    return;
  }
  if (stale()) {
    fail("The workspace changed while selecting a file; nothing was attached.");
    return;
  }
  const read = readFile(picked, folders);
  if (!read.ok) {
    fail(read.error.message);
    return;
  }
  const att = attachmentFrom(read, folders);
  if (!attachments.commit(ticket, att)) {
    return;
  }
  const r = read.result;
  showAttachment(att, `${r.path}:${r.start_line}–${r.end_line} · ${r.text.length.toLocaleString("en-US")} chars`);
}

function postContextPreview(): void {
  const r = currentContext();
  void panel?.webview.postMessage({ type: "context", ok: r.ok, text: r.ok ? r.summary : r.message });
}

function trackEditor(editor: vscode.TextEditor | undefined): void {
  // Every editor is tracked, supported or not, so an unsupported one can never be replaced by a stale file.
  tracker.setActive(editor);
  postContextPreview();
}

export function activate(context: vscode.ExtensionContext): void {
  trackEditor(vscode.window.activeTextEditor);
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(trackEditor),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (attachments.peek()) {
        dropAttachment("The workspace folders changed, so the attached file was removed.");
      } else {
        attachments.clear();
      }
    }),
    vscode.window.onDidChangeTextEditorSelection(() => postContextPreview()),
    vscode.commands.registerCommand("riseAssistant.ask", () => {
      if (panel) {
        panel.reveal();
        postContextPreview();
        return;
      }
      panel = vscode.window.createWebviewPanel(
        "riseAssistant",
        "RISE Assistant",
        vscode.ViewColumn.Beside,
        { enableScripts: true }
      );
      const nonce = crypto.randomBytes(16).toString("base64");
      panel.webview.html = getWebviewHtml(nonce, panel.webview.cspSource);
      postContextPreview();
      panel.webview.onDidReceiveMessage(async (msg: unknown) => {
        const m = msg as { type?: string; text?: unknown; useContext?: unknown };
        if (m?.type === "attachFile") {
          await attachWorkspaceFile();
          return;
        }
        if (m?.type === "clearAttachment") {
          dropAttachment();
          return;
        }
        if (!m || m.type !== "ask" || typeof m.text !== "string") {
          return;
        }
        const target = panel;
        // A reply that arrives after the panel was closed (or replaced) is dropped, not posted to a dead webview.
        const post = (message: object) => {
          if (panel === target) {
            void target?.webview.postMessage(message);
          }
        };

        // Context is attached only when the user asked for it; if it is unusable, send nothing.
        let attached;
        if (m.useContext === true) {
          const r = currentContext();
          if (!r.ok) {
            post({ type: "error", text: r.message });
            return;
          }
          attached = r.context;
          post({ type: "note", text: r.summary });
        }

        // The attached file is re-read now. If that fails, nothing is sent: never ask without the file.
        // It is consumed before the first await, so a late reply cannot clear a newer attachment.
        let toolResults;
        const att = attachments.peek();
        if (att) {
          const read = rereadAttachment(att, workspaceFolders());
          if (!read.ok) {
            post({ type: "error", text: `Attached file could not be read, nothing was sent. ${read.error.message} Remove it or attach it again.` });
            return;
          }
          attachments.take();
          showAttachment(undefined);
          toolResults = [read.result];
          post({
            type: "note",
            text: `read_file · ${read.result.path}:${read.result.start_line}–${read.result.end_line} · ${read.result.text.length.toLocaleString("en-US")} chars (attached by you)`,
          });
        }

        const cfg = vscode.workspace.getConfiguration("riseAssistant");
        try {
          const result = await postChat(
            cfg.get<string>("backendUrl", DEFAULT_BACKEND_URL),
            m.text,
            cfg.get<number>("requestTimeoutMs", DEFAULT_TIMEOUT_MS),
            attached,
            toolResults
          );
          post({ type: "reply", text: result.reply });
        } catch (err) {
          const text = err instanceof BackendError ? err.message : "Unexpected error contacting the backend.";
          post({ type: "error", text });
        }
      });
      panel.onDidDispose(() => {
        panel = undefined;
        attachments.clear();
      });
    })
  );
}

export function deactivate(): void {}
