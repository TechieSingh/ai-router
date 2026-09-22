import * as vscode from 'vscode';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Store } from './store';
import { Agent } from './agent';
import { McpManager } from './mcp';
import { validateEndpoint } from './providers';
import type { Mode, Settings, ToolHost } from './types';

let shutdown: (() => Promise<void>) | undefined;
export async function activate(context: vscode.ExtensionContext) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || !context.storageUri) { vscode.window.showInformationMessage('Open a trusted project folder to use Jev Router.'); return; }
  const root = await fs.realpath(folder.uri.fsPath);
  const initSql = require(path.join(context.extensionPath, 'dist', 'sql-wasm.cjs'));
  const SQL = await initSql({ locateFile: () => path.join(context.extensionPath, 'dist', 'sql-wasm.wasm') });
  const store = new Store(SQL, path.join(context.storageUri.fsPath, 'history.sqlite'));
  const mcp = new McpManager(); const virtual = new Map<string, string>();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('jev-diff', { provideTextDocumentContent: uri => virtual.get(uri.toString()) ?? '' }));
  const host: ToolHost = {
    async approve(title, detail) {
      const answer = await vscode.window.showWarningMessage(title, { modal: true, detail: `${detail.slice(0, 6000)}\n\nProject: ${root}` }, 'Allow');
      return answer === 'Allow';
    },
    async reviewEdit(file, before, after) {
      const id = randomUUID(); const left = vscode.Uri.parse(`jev-diff:/${id}/before/${path.basename(file)}`); const right = vscode.Uri.parse(`jev-diff:/${id}/proposed/${path.basename(file)}`);
      virtual.set(left.toString(), before); virtual.set(right.toString(), after);
      await vscode.commands.executeCommand('vscode.diff', left, right, `Proposed: ${path.relative(root, file)}`, { preview: true });
      return await vscode.window.showInformationMessage(`Apply proposed changes to ${path.relative(root, file)}?`, 'Apply', 'Reject') === 'Apply';
    },
    isDirty: file => vscode.workspace.textDocuments.some(d => d.uri.scheme === 'file' && path.resolve(d.uri.fsPath).toLowerCase() === path.resolve(file).toLowerCase() && d.isDirty)
  };
  let view: vscode.WebviewView | undefined;
  let current = context.workspaceState.get<string>('currentThread');
  if (!current || !store.threads(root).some(t => t.id === current)) current = store.threads(root)[0]?.id ?? store.createThread(root).id;
  const post = (message: unknown) => view?.webview.postMessage(message);
  const agent = new Agent(store, root, root, host, mcp, update => { post(update); if (update.type === 'status') void sendState(); });
  async function settings(): Promise<Settings> {
    const c = vscode.workspace.getConfiguration('jevRouter');
    const keys = await Promise.all(['local', 'cloud', 'jev', 'search'].map(name => context.secrets.get(`jevRouter.${name}`)));
    return {
      local: { baseUrl: c.get<string>('localUrl')!, model: c.get<string>('localModel')!, context: c.get<number>('localContext')!, key: keys[0] },
      cloud: { baseUrl: c.get<string>('cloudUrl')!, model: c.get<string>('cloudModel')!, context: c.get<number>('cloudContext')!, key: keys[1] },
      jevKey: keys[2], searchKey: keys[3], maxOutputTokens: c.get<number>('maxOutputTokens')!, maxSteps: c.get<number>('maxSteps')!,
      dailyBudgetUsd: c.get<number>('dailyBudgetUsd')!, runBudgetUsd: c.get<number>('runBudgetUsd')!,
      inputPricePerMillion: c.get<number>('inputPricePerMillion')!, outputPricePerMillion: c.get<number>('outputPricePerMillion')!,
      jevTimeoutMs: c.get<number>('jevTimeoutMs')!, autoApproveEdits: c.get<boolean>('autoApproveEdits')!, mcpServers: c.get('mcpServers', [])
    };
  }
  async function sendState() {
    const s = await settings();
    post({ type: 'state', thread: current, threads: store.threads(root), events: store.events(current!), busy: agent.busy, runningThread: agent.runningThread,
      project: path.basename(root), spent: store.spent(), budget: s.dailyBudgetUsd,
      configured: { jev: Boolean(s.jevKey), cloud: Boolean(s.cloud.key), search: Boolean(s.searchKey) }, models: { local: s.local.model, cloud: s.cloud.model }, memory: store.getMemory(root) });
  }
  async function configure() {
    const choice = await vscode.window.showQuickPick([
      { label: 'TypeSafe Jev', id: 'jev', detail: 'Routing API key' },
      { label: 'Cloud provider', id: 'cloud', detail: 'Venice API key' },
      { label: 'Brave Search', id: 'search', detail: 'Optional web search API key' },
      { label: 'Local endpoint', id: 'local', detail: 'Optional key for your local model server' }
    ], { title: 'Store an API key securely' });
    if (!choice) return;
    const key = await vscode.window.showInputBox({ title: `${choice.label} API key`, prompt: 'Stored in VS Code SecretStorage. Leave blank to remove the saved key.', password: true, ignoreFocusOut: true });
    if (key === undefined) return;
    if (key.trim()) await context.secrets.store(`jevRouter.${choice.id}`, key.trim()); else await context.secrets.delete(`jevRouter.${choice.id}`);
    await sendState(); vscode.window.showInformationMessage(`${choice.label} key ${key.trim() ? 'saved' : 'removed'}.`);
  }
  async function diagnostics() {
    const s = await settings(); const results: string[] = [];
    for (const name of ['local', 'cloud'] as const) {
      try {
        const config = s[name]; if (name === 'cloud' && !config.key) { results.push('Cloud: key not configured'); continue; }
        validateEndpoint(config.baseUrl);
        const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/models`, { redirect: 'error', signal: AbortSignal.timeout(8000), headers: config.key ? { Authorization: `Bearer ${config.key}` } : {} });
        if (!response.ok) { await response.body?.cancel(); results.push(`${name}: HTTP ${response.status}`); continue; }
        const body: any = await response.json(); const ids = (body.data ?? []).map((m: any) => m.id);
        results.push(`${name}: connected; ${ids.includes(config.model) ? 'configured model found' : `configured model ${config.model} not in catalog; available: ${ids.slice(0, 8).join(', ')}`}`);
      } catch { results.push(`${name}: unavailable. Start the server or check endpoint settings.`); }
    }
    results.push(`Jev: ${s.jevKey ? 'key saved; validated on the next Auto request' : 'key not configured'}`);
    post({ type: 'notice', text: results.join('\n') });
    vscode.window.showInformationMessage(results.join(' | '));
  }
  async function editMemory() {
    const content = await vscode.window.showInputBox({ title: 'Shared project memory', prompt: 'Durable project facts shared across chats. No credentials.', value: store.getMemory(root), ignoreFocusOut: true });
    if (content !== undefined) store.setMemory(root, content); await sendState();
  }
  async function handle(message: any) {
    if (!message || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'ready': await sendState(); break;
      case 'configure': await configure(); break;
      case 'settings': await vscode.commands.executeCommand('workbench.action.openSettings', 'jevRouter'); break;
      case 'diagnostics': await diagnostics(); break;
      case 'memory': await editMemory(); break;
      case 'new': current = store.createThread(root).id; await context.workspaceState.update('currentThread', current); await sendState(); break;
      case 'select': if (typeof message.id === 'string' && store.threads(root).some(t => t.id === message.id)) { current = message.id; await context.workspaceState.update('currentThread', current); await sendState(); } break;
      case 'cancel': agent.cancel(); break;
      case 'mcp': {
        if (agent.busy) throw new Error('Wait for the active run before changing MCP connections.');
        const s = await settings();
        if (!s.mcpServers.length) { post({ type: 'notice', text: 'Add trusted servers in Jev Router › Mcp Servers settings. See README for a Playwright browser example.' }); await vscode.commands.executeCommand('workbench.action.openSettings', 'jevRouter.mcpServers'); }
        else post({ type: 'notice', text: (await mcp.connect(s.mcpServers, host)).join('\n') });
        break;
      }
      case 'send': {
        if (!['auto', 'local', 'cloud', 'offline'].includes(message.mode) || typeof message.text !== 'string') throw new Error('Invalid chat request.');
        const s = await settings();
        if (message.mode === 'offline' && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(s.local.baseUrl).hostname)) throw new Error('Offline mode requires a loopback local model URL.');
        await agent.run(current!, message.text, message.mode as Mode, s); await sendState(); break;
      }
    }
  }
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('jevRouter.chat', {
    async resolveWebviewView(resolved) {
      view = resolved; const webview = resolved.webview;
      webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] };
      const nonce = randomBytes(16).toString('hex');
      const template = await fs.readFile(path.join(context.extensionPath, 'media', 'chat.html'), 'utf8');
      webview.html = template.replaceAll('{{nonce}}', nonce).replaceAll('{{cspSource}}', webview.cspSource)
        .replaceAll('{{styleUri}}', webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'chat.css')).toString())
        .replaceAll('{{scriptUri}}', webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'chat.js')).toString());
      webview.onDidReceiveMessage(message => { void handle(message).catch(e => { post({ type: 'notice', text: e.message }); }); }, undefined, context.subscriptions);
      resolved.onDidDispose(() => { view = undefined; });
    }
  }, { webviewOptions: { retainContextWhenHidden: true } }));
  context.subscriptions.push(vscode.commands.registerCommand('jevRouter.open', () => vscode.commands.executeCommand('jevRouter.chat.focus')),
    vscode.commands.registerCommand('jevRouter.configure', configure), vscode.commands.registerCommand('jevRouter.settings', () => vscode.commands.executeCommand('workbench.action.openSettings', 'jevRouter')),
    vscode.commands.registerCommand('jevRouter.diagnostics', diagnostics), vscode.commands.registerCommand('jevRouter.memory', editMemory),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('jevRouter')) void sendState(); }));
  shutdown = async () => {
    agent.cancel();
    for (let i = 0; i < 30 && agent.busy; i++) await new Promise(resolve => setTimeout(resolve, 100));
    await mcp.close(); if (!agent.busy) store.close();
  };
}
export async function deactivate() { await shutdown?.(); }
