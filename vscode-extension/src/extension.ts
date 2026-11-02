import * as crypto from "crypto";
import * as vscode from "vscode";
import { BackendError, BackendOfflineError, DEFAULT_BACKEND_URL, DEFAULT_TIMEOUT_MS, getModelInfo, postChat } from "./client";
import { ContextResult, EditorTracker, extractContext } from "./context";
import { Outbox, ViewHolder } from "./view";
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

export const CHAT_VIEW_ID = "riseAssistant.chatView";

const views = new ViewHolder<vscode.WebviewView>();
type WebviewMessage = { type: string } & Record<string, unknown>;
// Per-view delivery queue: a message the hidden webview cannot take yet is kept and replayed in order.
const outboxes = new WeakMap<vscode.WebviewView, Outbox<WebviewMessage>>();

function postTo(view: vscode.WebviewView, message: WebviewMessage): void {
  if (views.isCurrent(view)) {
    outboxes.get(view)?.post(message);
  }
}

function postCurrent(message: WebviewMessage): void {
  const view = views.get();
  if (view) {
    postTo(view, message);
  }
}
const tracker = new EditorTracker<vscode.TextEditor>();

// The one workspace file the user attached; it is re-read (and re-checked) when the message is sent.
const attachments = new AttachmentStore();
// Text of the attachment chip, kept so a re-resolved view can show the pending attachment again.
let attachmentSummary = "";

function workspaceFolders() {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => ({ name: f.name, fsPath: f.uri.fsPath }));
}

function currentContext(): ContextResult {
  const editor = tracker.pick(vscode.window.activeTextEditor, vscode.window.visibleTextEditors);
  return extractContext(editor, workspaceFolders());
}

function showAttachment(att: Attachment | undefined, summary = ""): void {
  attachmentSummary = att ? summary : "";
  postCurrent({ type: "attachment", text: attachmentSummary });
}

function dropAttachment(reason?: string): void {
  attachments.clear();
  showAttachment(undefined);
  if (reason) {
    postCurrent({ type: "error", text: reason });
  }
}

async function findCandidates(query: string): Promise<string[]> {
  const uris = await vscode.workspace.findFiles(caseInsensitiveGlob(query), SEARCH_EXCLUDE, 500);
  return uris.filter((u) => u.scheme === "file").map((u) => u.fsPath);
}

/** search_files then read_file, both initiated by the user: they type the query and pick the file. */
async function attachWorkspaceFile(target: vscode.WebviewView): Promise<void> {
  const ticket = attachments.begin();
  const folders = workspaceFolders();
  const fail = (text: string) => postTo(target, { type: "error", text });
  // Anything that happened while a picker was open (view disposed or replaced, workspace changed, newer attach) cancels this one.
  const stale = () => !views.isCurrent(target) || !sameFolders(folders, workspaceFolders());
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
  postCurrent({ type: "context", ok: r.ok, text: r.ok ? r.summary : r.message });
}

// Newest model-info request wins; an older answer that arrives late is dropped.
let modelInfoSeq = 0;

/**
 * Shows the provider and model the backend is configured with. It is asked from the backend (never from the
 * model) each time, and the old value is replaced by "checking" first, so a stopped backend is never shown
 * with a stale model name.
 */
async function refreshModelInfo(): Promise<void> {
  const view = views.get();
  if (!view) {
    return;
  }
  const seq = ++modelInfoSeq;
  postTo(view, { type: "modelInfo", state: "checking" });
  let message: WebviewMessage;
  try {
    const url = vscode.workspace.getConfiguration("riseAssistant").get<string>("backendUrl", DEFAULT_BACKEND_URL);
    const info = await getModelInfo(url);
    message = { type: "modelInfo", state: "ok", provider: info.provider, model: info.model };
  } catch (err) {
    message = { type: "modelInfo", state: err instanceof BackendOfflineError ? "offline" : "unavailable" };
  }
  if (seq === modelInfoSeq) {
    postTo(view, message);
  }
}

/** Brings a (re)resolved or re-shown view up to date: what would be sent, any pending attachment, and the model. */
function syncView(): void {
  void refreshModelInfo();
  postContextPreview();
  postCurrent({ type: "attachment", text: attachments.peek() ? attachmentSummary : "" });
}

function trackEditor(editor: vscode.TextEditor | undefined): void {
  // Every editor is tracked, supported or not, so an unsupported one can never be replaced by a stale file.
  tracker.setActive(editor);
  postContextPreview();
}

async function handleMessage(view: vscode.WebviewView, msg: unknown): Promise<void> {
  // An old view can still send messages after its replacement resolved but before it is disposed: ignore them.
  if (!views.isCurrent(view)) {
    return;
  }
  const m = msg as { type?: string; text?: unknown; useContext?: unknown };
  if (m?.type === "attachFile") {
    await attachWorkspaceFile(view);
    return;
  }
  if (m?.type === "clearAttachment") {
    dropAttachment();
    return;
  }
  if (!m || m.type !== "ask" || typeof m.text !== "string") {
    return;
  }
  // A reply that arrives after this view was disposed (or replaced) is dropped, not posted to a dead webview.
  const post = (message: WebviewMessage) => postTo(view, message);

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
    void refreshModelInfo(); // the backend may have stopped: do not keep showing an old model as active
  }
}

class ChatViewProvider implements vscode.WebviewViewProvider {
  resolveWebviewView(view: vscode.WebviewView): void {
    const previous = views.get();
    views.set(view);
    if (previous) {
      outboxes.get(previous)?.close(); // never replay anything to a replaced view
    }
    const outbox = new Outbox<WebviewMessage>(
      (message) => view.webview.postMessage(message),
      () => views.isCurrent(view),
      new Set(["context", "attachment", "modelInfo"])
    );
    outboxes.set(view, outbox);
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    const nonce = crypto.randomBytes(16).toString("base64");
    view.webview.html = getWebviewHtml(nonce, view.webview.cspSource);
    const messages = view.webview.onDidReceiveMessage((msg: unknown) => handleMessage(view, msg));
    // Hiding the view keeps its state (retainContextWhenHidden); only disposal discards the attachment.
    const visibility = view.onDidChangeVisibility(() => {
      if (view.visible && views.isCurrent(view)) {
        void outbox.flush(); // replay what could not be delivered while hidden
        syncView();
      }
    });
    view.onDidDispose(() => {
      messages.dispose();
      visibility.dispose();
      outbox.close();
      if (views.release(view)) {
        attachments.clear();
        attachmentSummary = "";
      }
    });
    syncView();
  }
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
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, new ChatViewProvider(), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("riseAssistant.ask", async () => {
      await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
      syncView();
    })
  );
}

export function deactivate(): void {}
