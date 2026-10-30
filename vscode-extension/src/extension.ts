import * as crypto from "crypto";
import * as vscode from "vscode";
import { placeholderReply } from "./placeholder";
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
      panel.webview.onDidReceiveMessage((msg: unknown) => {
        const m = msg as { type?: string; text?: unknown };
        if (m && m.type === "ask" && typeof m.text === "string") {
          void panel?.webview.postMessage({ type: "reply", text: placeholderReply(m.text) });
        }
      });
      panel.onDidDispose(() => {
        panel = undefined;
      });
    })
  );
}

export function deactivate(): void {}
