import * as crypto from "crypto";
import * as vscode from "vscode";
import { BackendError, DEFAULT_BACKEND_URL, DEFAULT_TIMEOUT_MS, postChat } from "./client";
import { ContextResult, EditorTracker, extractContext } from "./context";
import { getWebviewHtml } from "./webview";

let panel: vscode.WebviewPanel | undefined;
const tracker = new EditorTracker<vscode.TextEditor>();

function currentContext(): ContextResult {
  const editor = tracker.pick(vscode.window.activeTextEditor, vscode.window.visibleTextEditors);
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => ({ name: f.name, fsPath: f.uri.fsPath }));
  return extractContext(editor, folders);
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
        if (!m || m.type !== "ask" || typeof m.text !== "string") {
          return;
        }
        const target = panel;
        const post = (message: object) => void target?.webview.postMessage(message);

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

        const cfg = vscode.workspace.getConfiguration("riseAssistant");
        try {
          const result = await postChat(
            cfg.get<string>("backendUrl", DEFAULT_BACKEND_URL),
            m.text,
            cfg.get<number>("requestTimeoutMs", DEFAULT_TIMEOUT_MS),
            attached
          );
          post({ type: "reply", text: result.reply });
        } catch (err) {
          const text = err instanceof BackendError ? err.message : "Unexpected error contacting the backend.";
          post({ type: "error", text });
        }
      });
      panel.onDidDispose(() => {
        panel = undefined;
      });
    })
  );
}

export function deactivate(): void {}
