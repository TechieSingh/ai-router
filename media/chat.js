/* The webview never receives API keys and renders all model text as text nodes. */
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
let state = { events: [], thread: null, busy: false };
let streaming = '';
const saved = vscode.getState() || {};
$('mode').value = saved.mode || 'auto'; $('prompt').value = saved.draft || '';
function persist() { vscode.setState({ mode: $('mode').value, draft: $('prompt').value }); }
function send(type, extra = {}) { vscode.postMessage({ type, ...extra }); }
for (const type of ['new', 'configure', 'diagnostics', 'mcp', 'settings', 'memory']) $(type).onclick = () => send(type);
$('stop').onclick = () => send('cancel');
$('threads').onchange = () => { streaming = ''; send('select', { id: $('threads').value }); };
$('mode').onchange = persist; $('prompt').oninput = persist;
document.querySelectorAll('[data-prompt]').forEach(button => { button.onclick = () => { $('prompt').value = button.dataset.prompt; persist(); $('prompt').focus(); }; });
$('prompt').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); } };
$('composer').onsubmit = event => {
  event.preventDefault(); const text = $('prompt').value.trim(); if (!text || state.busy) return;
  send('send', { text, mode: $('mode').value }); $('prompt').value = ''; persist(); state.busy = true; controls();
};
function controls() { document.body.classList.toggle('busy', state.busy); $('send').disabled = state.busy; $('stop').hidden = !state.busy; }
function textBlock(text) {
  const body = document.createElement('div'); body.className = 'body';
  const parts = (text || '').split(/```[^\n]*\n([\s\S]*?)```/g);
  parts.forEach((part, i) => { if (i % 2) { const pre = document.createElement('pre'); pre.textContent = part; body.append(pre); } else body.append(document.createTextNode(part)); });
  return body;
}
function message(role, text) {
  const item = document.createElement('article'); item.className = `message ${role}`;
  const label = document.createElement('div'); label.className = 'label'; label.textContent = role === 'user' ? 'You' : 'Assistant'; item.append(label, textBlock(text)); return item;
}
function render() {
  const main = $('messages'); const nearBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 90;
  const welcome = $('welcome'); if (welcome) welcome.hidden = state.events.some(e => e.kind === 'message');
  main.querySelectorAll('.rendered').forEach(node => node.remove());
  for (const event of state.events) {
    const p = event.payload; let item;
    if (event.kind === 'message' && (p.role === 'user' || (p.role === 'assistant' && p.content))) item = message(p.role, p.content);
    else if (event.kind === 'route') { item = document.createElement('div'); item.className = 'route'; item.textContent = `${p.target.toUpperCase()} · ${p.source} · ${p.latencyMs} ms — ${p.reason}`; }
    else if (event.kind === 'tool_started') {
      item = document.createElement('details'); item.className = 'tool';
      const summary = document.createElement('summary'); summary.textContent = p.name;
      const pre = document.createElement('pre'); const result = state.events.find(e => e.kind === 'message' && e.payload.role === 'tool' && e.payload.tool_call_id === p.id);
      pre.textContent = `${p.arguments}\n\n${result?.payload.content || 'Waiting for result…'}`; item.append(summary, pre);
    } else if (event.kind === 'error') { item = document.createElement('div'); item.className = 'error'; item.textContent = p.text; }
    else if (event.kind === 'context') { item = document.createElement('div'); item.className = 'context'; item.textContent = `${p.omitted} earlier messages available through history retrieval.`; }
    if (item) { item.classList.add('rendered'); main.append(item); }
  }
  if (streaming) { const item = message('assistant', streaming); item.classList.add('rendered'); main.append(item); }
  if (nearBottom || streaming) main.scrollTop = main.scrollHeight;
}
window.addEventListener('message', ({ data }) => {
  if (data.type === 'state') {
    if (state.thread !== data.thread) streaming = '';
    state = data; $('project').textContent = data.project;
    $('threads').replaceChildren(...data.threads.map(thread => { const option = document.createElement('option'); option.value = thread.id; option.textContent = thread.title; option.selected = thread.id === data.thread; return option; }));
    $('usage').textContent = `$${data.spent.toFixed(3)} / $${data.budget.toFixed(2)} today`;
    $('setup').hidden = data.configured.jev && data.configured.cloud;
    $('status').textContent = data.busy ? 'Task in progress…' : 'Ready'; controls(); render();
  } else if (data.type === 'notice') { $('notice').textContent = data.text; $('notice').hidden = false; if (!state.runningThread) { state.busy = false; controls(); } }
  else if (data.type === 'status') { state.busy = false; controls(); }
  else if (data.thread === state.thread) {
    if (data.type === 'delta') { streaming += data.text; render(); }
    else if (data.type === 'reset') { streaming = ''; render(); }
    else if (data.type === 'event') {
      state.events.push(data.event);
      if (data.event.kind === 'message' && data.event.payload.role === 'assistant') streaming = '';
      if (data.event.kind === 'run_started') { state.busy = true; state.runningThread = data.thread; controls(); }
      if (data.event.kind === 'run_finished') { streaming = ''; state.busy = false; state.runningThread = null; $('status').textContent = data.event.payload.status; controls(); }
      if (data.event.kind === 'status') $('status').textContent = data.event.payload.text;
      render();
    }
  }
});
send('ready');
