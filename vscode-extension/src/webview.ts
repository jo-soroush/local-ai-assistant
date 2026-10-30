export function getWebviewHtml(nonce: string, cspSource: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RISE Assistant</title>
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); padding: 8px; }
  #log { white-space: pre-wrap; margin-bottom: 12px; }
  .msg { margin: 6px 0; padding: 6px 8px; border-radius: 4px; background: var(--vscode-editor-inactiveSelectionBackground); }
  .user { font-weight: bold; }
  .error { color: var(--vscode-errorForeground); border: 1px solid var(--vscode-errorForeground); }
  textarea { width: 100%; box-sizing: border-box; min-height: 60px; }
</style>
</head>
<body>
<div id="log"></div>
<textarea id="input" placeholder="Ask the assistant (Ctrl/Cmd+Enter to send)"></textarea>
<button id="send">Send</button>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  function add(cls, label, text) {
    const d = document.createElement('div');
    d.className = 'msg ' + cls;
    d.textContent = label + ': ' + text;
    log.appendChild(d);
  }
  function send() {
    const text = input.value;
    if (!text.trim()) { return; }
    add('user', 'You', text);
    vscode.postMessage({ type: 'ask', text });
    input.value = '';
  }
  document.getElementById('send').addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { send(); }
  });
  window.addEventListener('message', (e) => {
    if (!e.data) { return; }
    if (e.data.type === 'reply') { add('assistant', 'Assistant', e.data.text); }
    else if (e.data.type === 'error') { add('error', 'Error', e.data.text); }
  });
</script>
</body>
</html>`;
}
