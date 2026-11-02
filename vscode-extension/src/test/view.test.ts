import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ViewHolder } from "../view";
import { AttachmentStore } from "../workspace";

const root = path.join(__dirname, "..", "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const extensionSource = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");

// ---- manifest ----

test("the chat view is a webview contributed to the Activity Bar", () => {
  const containers = manifest.contributes.viewsContainers;
  assert.deepEqual(Object.keys(containers), ["activitybar"]);
  assert.equal(containers.activitybar.length, 1);
  const container = containers.activitybar[0];
  assert.equal(container.id, "riseAssistant");
  assert.ok(fs.existsSync(path.join(root, container.icon)), "icon file exists");
  assert.match(fs.readFileSync(path.join(root, container.icon), "utf8"), /^<svg /);

  const views = manifest.contributes.views;
  assert.deepEqual(Object.keys(views), [container.id]);
  assert.equal(views[container.id].length, 1, "exactly one chat view (no duplicates)");
  assert.deepEqual(views[container.id][0], { type: "webview", id: "riseAssistant.chatView", name: "Chat" });
});

test("the view id in the manifest is the one the code registers and focuses", () => {
  assert.ok(extensionSource.includes('export const CHAT_VIEW_ID = "riseAssistant.chatView";'));
  assert.ok(extensionSource.includes("registerWebviewViewProvider(CHAT_VIEW_ID"));
  assert.ok(extensionSource.includes("retainContextWhenHidden: true"));
});

test("Ask is still contributed, now only focuses the sidebar and never opens an editor panel", () => {
  assert.ok(manifest.contributes.commands.some((c: { command: string }) => c.command === "riseAssistant.ask"));
  assert.ok(extensionSource.includes("`${CHAT_VIEW_ID}.focus`"));
  assert.ok(!/createWebviewPanel|WebviewPanel|ViewColumn/.test(extensionSource));
});

test("the declared VS Code version is the one this extension was verified on", () => {
  assert.equal(manifest.engines.vscode, "^1.141.0");
  assert.equal(manifest.dependencies, undefined, "no runtime dependencies");
});

test("existing configuration is unchanged", () => {
  const props = Object.keys(manifest.contributes.configuration.properties).sort();
  assert.deepEqual(props, ["riseAssistant.backendUrl", "riseAssistant.requestTimeoutMs"]);
});

// ---- view lifecycle ----

test("disposing a view that was already replaced does not clear the new view", () => {
  const v = new ViewHolder<object>();
  const oldView = {};
  const newView = {};
  v.set(oldView);
  v.set(newView); // VS Code resolved a new view before the old one was disposed
  assert.equal(v.release(oldView), false);
  assert.equal(v.get(), newView);
  assert.equal(v.release(newView), true);
  assert.equal(v.get(), undefined);
});

test("flows started in an old or disposed view see themselves as stale", () => {
  const v = new ViewHolder<object>();
  const a = {};
  const b = {};
  v.set(a);
  assert.equal(v.isCurrent(a), true);
  v.set(b);
  assert.equal(v.isCurrent(a), false);
  v.release(b);
  assert.equal(v.isCurrent(b), false);
  assert.equal(v.isCurrent(undefined), false);
});

test("hiding is not disposal: only a current view's disposal clears the attachment", () => {
  // Mirrors ChatViewProvider: visibility changes never touch the store; onDidDispose clears it only if current.
  const views = new ViewHolder<object>();
  const store = new AttachmentStore();
  const view = {};
  views.set(view);
  store.commit(store.begin(), { path: "a.py", realFile: "/x/a.py", folders: [] });
  assert.ok(store.peek(), "still attached while hidden");
  if (views.release(view)) {
    store.clear();
  }
  assert.equal(store.peek(), undefined);
});

test("an attach flow started in a view is cancelled by that view's disposal", () => {
  const views = new ViewHolder<object>();
  const store = new AttachmentStore();
  const view = {};
  views.set(view);
  const ticket = store.begin();
  if (views.release(view)) {
    store.clear();
  }
  assert.equal(views.isCurrent(view), false);
  assert.equal(store.commit(ticket, { path: "a.py", realFile: "/x/a.py", folders: [] }), false);
});
