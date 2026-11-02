// Runs the real chat page script against a tiny fake DOM to check how the model line is drawn.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as vm from "node:vm";
import { getWebviewHtml } from "../webview";

function loadPage() {
  const html = getWebviewHtml("n0nce", "vscode-resource:");
  const script = /<script nonce="n0nce">([\s\S]*)<\/script>/.exec(html)?.[1];
  assert.ok(script, "page script found");
  const elements: Record<string, { textContent: string; className: string; hidden: boolean; value: string; checked: boolean }> = {};
  const el = (id: string) =>
    (elements[id] ??= { textContent: html.includes(`id="${id}">`) ? "" : "", className: "", hidden: false, value: "", checked: true });
  let onMessage: (e: { data: unknown }) => void = () => {};
  const sandbox = {
    acquireVsCodeApi: () => ({ postMessage() {} }),
    document: {
      getElementById: el,
      createElement: () => ({ className: "", textContent: "" }),
    },
    window: { addEventListener: (_t: string, cb: typeof onMessage) => (onMessage = cb) },
  };
  // Elements need addEventListener / appendChild too.
  for (const id of ["useContext", "attach", "detach", "send", "input", "log"]) {
    Object.assign(el(id), { addEventListener() {}, appendChild() {} });
  }
  new vm.Script(script).runInNewContext(sandbox); // throws on a syntax error in the page script
  return { model: el("model"), post: (data: unknown) => onMessage({ data }), html };
}

test("the page script is valid and the model line starts as 'Checking backend…'", () => {
  const { html } = loadPage();
  assert.match(html, /<div id="model"[^>]*>Checking backend…<\/div>/);
});

test("model and provider are shown on two lines from the backend's answer", () => {
  const { model, post } = loadPage();
  post({ type: "modelInfo", state: "ok", provider: "Ollama", model: "qwen2.5-coder:7b" });
  assert.equal(model.textContent, "Model: qwen2.5-coder:7b\nProvider: Ollama");
  assert.equal(model.className, "");
});

test("offline replaces the model text, so no stale model remains", () => {
  const { model, post } = loadPage();
  post({ type: "modelInfo", state: "ok", provider: "Ollama", model: "qwen2.5-coder:7b" });
  post({ type: "modelInfo", state: "offline" });
  assert.equal(model.textContent, "Backend offline");
  assert.doesNotMatch(model.textContent, /qwen/);
  assert.equal(model.className, "warn");
});

test("'unavailable' and 'checking' states never show a model name", () => {
  const { model, post } = loadPage();
  post({ type: "modelInfo", state: "unavailable" });
  assert.equal(model.textContent, "Model info unavailable");
  post({ type: "modelInfo", state: "checking" });
  assert.equal(model.textContent, "Checking backend…");
});

test("the page does not claim the model is loaded, healthy or generating", () => {
  const { html } = loadPage();
  assert.doesNotMatch(html, /\b(loaded|healthy|generating|online|ready)\b/i);
});
