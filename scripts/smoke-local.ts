import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import initSql from 'sql.js';
import { Store } from '../src/store';
import { Agent } from '../src/agent';
import { McpManager } from '../src/mcp';
import type { Settings } from '../src/types';

async function main() {
  const root = path.resolve('.runtime', 'smoke-project'); await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'greeting.ts'), "export const greeting = 'hello';\n");
  const SQL = await initSql(); const store = new Store(SQL); const thread = store.createThread(root);
  const settings: Settings = { local: { baseUrl: 'http://127.0.0.1:8080/v1', model: 'local-coder', context: 8192 }, cloud: { baseUrl: 'https://api.venice.ai/api/v1', model: 'qwen-3-6-plus', context: 65536 }, maxOutputTokens: 1024, maxSteps: 6, dailyBudgetUsd: 0, runBudgetUsd: 0, inputPricePerMillion: .63, outputPricePerMillion: 3.75, jevTimeoutMs: 1500, autoApproveEdits: false, mcpServers: [] };
  const start = performance.now(); let firstToken: number | undefined;
  const updates: any[] = [];
  const agent = new Agent(store, root, root, { approve: async () => false, reviewEdit: async file => file === path.join(root, 'greeting.ts'), isDirty: () => false }, new McpManager(), update => {
    if (update.type === 'delta' && firstToken === undefined) firstToken = performance.now() - start;
    if (update.type === 'event') { updates.push(update.event); if (['status', 'error', 'tool_started'].includes(update.event!.kind)) console.log(update.event!.kind, JSON.stringify(update.event!.payload)); }
  });
  try {
    await agent.run(thread.id, "Read greeting.ts. Change only the string 'hello' to 'hello from local'. Use read_file to get the hash, then write_file to make the edit. Do not use terminal. Then state what changed.", 'local', settings);
    const contents = await fs.readFile(path.join(root, 'greeting.ts'), 'utf8');
    const success = contents.includes("'hello from local'") && !store.events(thread.id).some(e => e.kind === 'error');
    const result = { success, elapsedSeconds: (performance.now() - start) / 1000, firstTextSeconds: firstToken === undefined ? null : firstToken / 1000, gpu: execFileSync('nvidia-smi', ['--query-gpu=name,memory.used,memory.total,utilization.gpu', '--format=csv,noheader'], { encoding: 'utf8', windowsHide: true }).trim(), events: updates };
    await fs.writeFile('.runtime/local-smoke-result.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ success: result.success, elapsedSeconds: result.elapsedSeconds, firstTextSeconds: result.firstTextSeconds, gpu: result.gpu }, null, 2));
    if (!success) process.exitCode = 1;
  } finally { store.close(); }
}
void main().catch(e => { console.error(e); process.exitCode = 1; });
