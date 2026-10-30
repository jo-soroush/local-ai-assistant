import * as crypto from "crypto";
import * as vscode from "vscode";
import { BackendError, DEFAULT_BACKEND_URL, DEFAULT_TIMEOUT_MS, postChat } from "./client";
import { getWebviewHtml } from "./webview";

let panel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("riseAssistant.ask", () => {
      if (panel) {
        panel.reveal();
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
      panel.webview.onDidReceiveMessage(async (msg: unknown) => {
        const m = msg as { type?: string; text?: unknown };
        if (!m || m.type !== "ask" || typeof m.text !== "string") {
          return;
        }
        const target = panel;
        const cfg = vscode.workspace.getConfiguration("riseAssistant");
        try {
          const result = await postChat(
            cfg.get<string>("backendUrl", DEFAULT_BACKEND_URL),
            m.text,
            cfg.get<number>("requestTimeoutMs", DEFAULT_TIMEOUT_MS)
          );
          void target?.webview.postMessage({ type: "reply", text: result.reply });
        } catch (err) {
          const text = err instanceof BackendError ? err.message : "Unexpected error contacting the backend.";
          void target?.webview.postMessage({ type: "error", text });
        }
      });
      panel.onDidDispose(() => {
        panel = undefined;
      });
    })
  );
}

export function deactivate(): void {}
