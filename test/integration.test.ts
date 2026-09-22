import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import initSql from 'sql.js';
import { Store } from '../src/store';
import { Agent } from '../src/agent';
import { McpManager } from '../src/mcp';
import { ChatProvider } from '../src/providers';
import type { Settings, ToolHost } from '../src/types';
const host: ToolHost = { approve: async () => true, reviewEdit: async () => true, isDirty: () => false };
async function listen(server: http.Server) { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${(server.address() as any).port}/v1`; }
test('real HTTP streaming agent reads, edits, and reopens its persisted work', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-http-')); await fs.writeFile(path.join(dir, 'hello.ts'), 'export const hello = 1;');
  const requests: any[] = []; let step = 0;
  const server = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk; const parsed = JSON.parse(body); requests.push(parsed);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let delta: any; let finish = 'tool_calls';
    if (step++ === 0) delta = { tool_calls: [{ index: 0, id: 'read', type: 'function', function: { name: 'read_file', arguments: '{"path":"hello.ts"}' } }] };
    else if (step === 2) {
      const result = parsed.messages.find((m: any) => m.tool_call_id === 'read'); const digest = /SHA256: (\w+)/.exec(result.content)![1];
      delta = { tool_calls: [{ index: 0, id: 'edit', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'hello.ts', expected_hash: digest, content: 'export const hello = 2;' }) } }] };
    } else { delta = { content: 'Updated hello to 2.' }; finish = 'stop'; }
    response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`); response.end('data: [DONE]\n\n');
  });
  const url = await listen(server); const SQL = await initSql(); const db = path.join(dir, 'history.sqlite'); const store = new Store(SQL, db); const thread = store.createThread(dir); let reviews = 0;
  const settings: Settings = { local: { baseUrl: url, model: 'fixture', context: 16384 }, cloud: { baseUrl: url, model: 'cloud', context: 16384 }, maxOutputTokens: 512, maxSteps: 6, dailyBudgetUsd: 1, runBudgetUsd: 1, inputPricePerMillion: 1, outputPricePerMillion: 1, jevTimeoutMs: 1000, autoApproveEdits: false, mcpServers: [] };
  const agent = new Agent(store, dir, dir, { ...host, reviewEdit: async () => { reviews++; return true; } }, new McpManager(), () => {});
  try {
    await agent.run(thread.id, 'Change hello to 2', 'local', settings);
    assert.equal(await fs.readFile(path.join(dir, 'hello.ts'), 'utf8'), 'export const hello = 2;'); assert.equal(reviews, 1); assert.equal(requests.length, 3);
    assert.ok(requests[2].messages.some((m: any) => m.tool_call_id === 'edit'));
    store.close(); const reopened = new Store(SQL, db); assert.equal(reopened.messages(thread.id).at(-1)?.content, 'Updated hello to 2.'); reopened.close();
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(dir, { recursive: true, force: true }); }
});
test('MCP stdio discovers, validates, and calls real protocol tools', async () => {
  const mcp = new McpManager();
  try {
    const status = await mcp.connect([{ name: 'echo', command: process.execPath, args: [path.resolve('test/fixtures/mcp-server.mjs')] }], host);
    assert.match(status[0], /1 tools connected/); assert.match(mcp.catalog(), /echo/);
    const result = await mcp.call('mcp_echo_1', { text: 'hello MCP' }, new AbortController().signal); assert.match(result, /hello MCP/);
    await assert.rejects(mcp.call('mcp_echo_1', { bad: true }, new AbortController().signal), /Invalid MCP/);
  } finally { await mcp.close(); }
});
test('cancellation aborts a streaming HTTP response before executing tools', async () => {
  let started!: () => void; const ready = new Promise<void>(r => { started = r; });
  const server = http.createServer((_, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write('data: {"choices":[{"delta":{"content":"working"}}]}\n\n'); started(); });
  const url = await listen(server); const controller = new AbortController();
  try {
    const pending = new ChatProvider().complete({ baseUrl: url, model: 'test', context: 8192 }, [], [], 500, controller.signal, () => {});
    await ready; controller.abort(); await assert.rejects(pending);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
