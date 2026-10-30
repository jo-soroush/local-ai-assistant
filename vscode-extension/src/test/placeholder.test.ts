import { test } from "node:test";
import * as assert from "node:assert/strict";
import { placeholderReply } from "../placeholder";
import { getWebviewHtml } from "../webview";

test("placeholder echoes trimmed input and is labelled", () => {
  assert.equal(
    placeholderReply("  hello  "),
    "[placeholder] No model is connected yet. You asked: hello"
  );
});

test("placeholder handles empty and whitespace input", () => {
  assert.equal(placeholderReply(""), "Please enter a question.");
  assert.equal(placeholderReply("  \n "), "Please enter a question.");
});

test("webview html has strict CSP with nonce and no remote URLs", () => {
  const html = getWebviewHtml("abc123", "vscode-resource:");
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-abc123'/);
  assert.doesNotMatch(html, /https?:\/\//);
});
