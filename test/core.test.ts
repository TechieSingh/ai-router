import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import initSql from 'sql.js';
import { Store } from '../src/store';
import { buildContext, ContextOverflow } from '../src/context';
import { chooseRoute } from '../src/router';
import { ChatProvider, sse, validateEndpoint } from '../src/providers';
import { Agent } from '../src/agent';
import { McpManager } from '../src/mcp';
import { safePath, ToolExecutor, isPublicAddress, fetchPage } from '../src/tools';
import type { Completion, Message, Settings, ToolHost } from '../src/types';

const config: Settings = { local: { baseUrl: 'http://127.0.0.1:8080/v1', model: 'local', context: 8192 }, cloud: { baseUrl: 'https://example.org/v1', model: 'cloud', context: 65536, key: 'secret-cloud-key' }, jevKey: 'secret-jev-key', maxOutputTokens: 512, maxSteps: 5, dailyBudgetUsd: 5, runBudgetUsd: 1, inputPricePerMillion: .63, outputPricePerMillion: 3.75, jevTimeoutMs: 1000, autoApproveEdits: false, mcpServers: [] };
const host: ToolHost = { approve: async () => true, reviewEdit: async () => true, isDirty: () => false };
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-test-')); const SQL = await initSql(); const store = new Store(SQL, path.join(dir, 'history.sqlite')); const thread = store.createThread(dir);
  return { dir, SQL, store, thread, cleanup: async () => { store.close(); await fs.rm(dir, { recursive: true, force: true }); } };
}
test('persistent threads remain isolated and share only project memory', async () => {
  const f = await fixture();
  f.store.append(f.thread.id, 'r', 'message', { role: 'user', content: 'private thread content' });
  f.store.setMemory(f.dir, 'Use strict TypeScript.'); const other = f.store.createThread(f.dir);
  assert.equal(f.store.messages(other.id).length, 0); assert.equal(f.store.getMemory('different'), ''); f.store.close();
  const reopened = new Store(f.SQL, path.join(f.dir, 'history.sqlite'));
  assert.equal(reopened.messages(f.thread.id)[0].content, 'private thread content'); assert.equal(reopened.getMemory(f.dir), 'Use strict TypeScript.');
  reopened.close(); await fs.rm(f.dir, { recursive: true, force: true });
});
test('restart pairs interrupted tool calls without replaying them', async () => {
  const f = await fixture(); f.store.append(f.thread.id, 'run', 'run_started', {});
  f.store.append(f.thread.id, 'run', 'message', { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'run_terminal', arguments: '{}' } }] }); f.store.close();
  const reopened = new Store(f.SQL, path.join(f.dir, 'history.sqlite'));
  const results = reopened.messages(f.thread.id).filter(m => m.role === 'tool');
  assert.equal(results.length, 1); assert.equal(results[0].tool_call_id, 'c'); assert.match(results[0].content!, /unknown/);
  reopened.close(); await fs.rm(f.dir, { recursive: true, force: true });
});
test('second database owner is rejected', async () => { const f = await fixture(); try { assert.throws(() => new Store(f.SQL, path.join(f.dir, 'history.sqlite')), /another VS Code/); } finally { await f.cleanup(); } });
test('context drops whole old turns while preserving tool pairs and original history', () => {
  const history: Message[] = [{ role: 'user', content: 'original task' }, { role: 'assistant', content: 'x'.repeat(10000) }, { role: 'user', content: 'current task' }, { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c', content: 'evidence' }];
  const context = buildContext(history, '', [], 4096, 512); assert.equal(context.omitted, 2); assert.equal(history.length, 5); assert.equal(context.messages.at(-1)?.content, 'evidence'); assert.match(context.messages[0].content!, /original task/);
});
test('oversized active objective is not silently truncated out of working context', () => { assert.throws(() => buildContext([{ role: 'user', content: 'x'.repeat(40000) }], '', [], 8192, 512), ContextOverflow); });
test('Jev uses documented Choice contract and confidence', async () => {
  let request: any;
  const fetcher = (async (url: any, options: any) => { assert.equal(url, 'https://api.typesafe.ai/v1/systemone'); request = JSON.parse(options.body); return Response.json({ answers: { route: { choice: 'local', confidence: .9 } } }); }) as typeof fetch;
  const route = await chooseRoute('auto', [{ role: 'user', content: 'Explain this function' }], config, new AbortController().signal, fetcher);
  assert.equal(request.questions.route.type, 'choice'); assert.ok(request.questions.route.criteria.local); assert.equal(route.target, 'local'); assert.equal(route.source, 'jev');
});
test('uncertain local Jev decision chooses cloud; outage fallback is visible', async () => {
  const uncertain = (async () => Response.json({ answers: { route: { choice: 'local', confidence: .2 } } })) as typeof fetch;
  assert.equal((await chooseRoute('auto', [{ role: 'user', content: 'fix' }], config, new AbortController().signal, uncertain)).target, 'cloud');
  const down = (async () => { throw new Error('offline'); }) as typeof fetch;
  const route = await chooseRoute('auto', [{ role: 'user', content: 'refactor across files' }], config, new AbortController().signal, down); assert.equal(route.source, 'fallback'); assert.equal(route.target, 'cloud');
});
test('manual and offline modes never call Jev', async () => {
  const noNetwork = (async () => { throw new Error('must not be called'); }) as typeof fetch;
  for (const mode of ['local', 'offline'] as const) assert.equal((await chooseRoute(mode, [], config, new AbortController().signal, noNetwork)).target, 'local');
});
test('SSE parses fragmented unicode and CRLF frames', async () => {
  const bytes = new TextEncoder().encode('data: {"word":"héllo"}\r\n\r\ndata: [DONE]\n\n');
  const stream = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } });
  const result = []; for await (const part of sse(stream)) result.push(part); assert.deepEqual(result, [{ word: 'héllo' }]);
});
test('provider refuses a partial tool call on a broken stream', async () => {
  const fetcher = (async () => new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"write_file","arguments":"{\\\"path\\\":"}}]}}]}\n\n')) as typeof fetch;
  await assert.rejects(new ChatProvider(fetcher).complete(config.local, [], [], 512, new AbortController().signal, () => {}), /prematurely/);
});
test('provider accumulates tool arguments and preserves usage', async () => {
  const chunks = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'read_file', arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 90, completion_tokens: 12 } }
  ];
  const fetcher = (async () => new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n')) as typeof fetch;
  const result = await new ChatProvider(fetcher).complete(config.local, [], [], 512, new AbortController().signal, () => {});
  assert.equal(result.message.tool_calls![0].function.arguments, '{"path":"a.ts"}'); assert.equal(result.usage?.prompt_tokens, 90);
});
test('endpoint validation prevents plaintext remote credentials', () => { assert.throws(() => validateEndpoint('http://example.com')); assert.throws(() => validateEndpoint('https://user:password@example.com')); validateEndpoint('http://127.0.0.1:8080/v1'); });
test('workspace path traversal and secret files are blocked', async () => {
  const f = await fixture(); try { for (const rel of ['../outside', '.env', '.env.local', '.git/config', 'key.pem']) await assert.rejects(safePath(f.dir, rel)); } finally { await f.cleanup(); }
});
test('workspace symlink escape is blocked', async t => {
  const f = await fixture(); const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-outside-'));
  try { try { await fs.symlink(outside, path.join(f.dir, 'link'), 'junction'); } catch (e: any) { if (e.code === 'EPERM') { t.skip('Symlink permission unavailable'); return; } throw e; } await assert.rejects(safePath(f.dir, 'link/file.txt'), /escapes/); }
  finally { await f.cleanup(); await fs.rm(outside, { recursive: true, force: true }); }
});
test('file edits require a read and reject changes made during diff review', async () => {
  const f = await fixture(); const file = path.join(f.dir, 'test.ts'); await fs.writeFile(file, 'original');
  const mcp = new McpManager(); const editor = new ToolExecutor(f.dir, f.dir, f.thread.id, 'local', config, f.store, { ...host, reviewEdit: async () => { await fs.writeFile(file, 'human edit'); return true; } }, mcp);
  try {
    const read = await editor.execute('read_file', { path: 'test.ts' }, new AbortController().signal); const digest = /SHA256: (\w+)/.exec(read.content)![1];
    const result = await editor.execute('write_file', { path: 'test.ts', expected_hash: digest, content: 'agent edit' }, new AbortController().signal);
    assert.equal(result.failed, true); assert.match(result.content, /changed during review/); assert.equal(await fs.readFile(file, 'utf8'), 'human edit');
  } finally { await f.cleanup(); }
});
test('tool arguments are schema validated and offline tools are unavailable', async () => {
  const f = await fixture(); const executor = new ToolExecutor(f.dir, f.dir, f.thread.id, 'offline', config, f.store, host, new McpManager());
  try { assert.equal((await executor.execute('read_file', {}, new AbortController().signal)).failed, true); assert.equal((await executor.execute('web_fetch', { url: 'https://example.com' }, new AbortController().signal)).failed, true); assert.equal((await executor.execute('run_terminal', { command: 'echo hi' }, new AbortController().signal)).failed, true); }
  finally { await f.cleanup(); }
});
test('private addresses are not eligible for public web fetch', () => { for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.0.1', '172.16.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fe80::1']) assert.equal(isPublicAddress(ip), false); assert.equal(isPublicAddress('1.1.1.1'), true); });
test('web fetch rejects local services and credential-bearing URLs before connecting', async () => {
  const signal = new AbortController().signal;
  await assert.rejects(fetchPage('http://127.0.0.1/', signal), /Private and local/);
  await assert.rejects(fetchPage('https://user:pass@example.com/', signal), /public HTTP/);
});

class FakeProvider extends ChatProvider {
  calls: { model: string; messages: Message[] }[] = [];
  constructor(private response: (index: number) => Completion | Promise<Completion>) { super(); }
  override async complete(c: any, messages: Message[]): Promise<Completion> { this.calls.push({ model: c.model, messages: structuredClone(messages) }); return this.response(this.calls.length - 1); }
}
const answer = (content: string): Completion => ({ message: { role: 'assistant', content }, finishReason: 'stop', usage: { prompt_tokens: 50, completion_tokens: 20 } });
test('local to cloud to local retains one transcript and tool evidence', async () => {
  const f = await fixture();
  const provider = new FakeProvider(i => i === 0 ? { message: { role: 'assistant', content: null, tool_calls: [{ id: 'handoff', type: 'function', function: { name: 'escalate', arguments: '{"reason":"Need a larger model to diagnose the build"}' } }] }, finishReason: 'tool_calls' } : answer(i === 1 ? 'Cloud diagnosis' : 'Local follow-up'));
  const agent = new Agent(f.store, f.dir, f.dir, host, new McpManager(), () => {}, provider, async () => ({ target: 'local', source: 'jev', reason: 'test', latencyMs: 1 }));
  try {
    await agent.run(f.thread.id, 'Fix the build', 'auto', config); await agent.run(f.thread.id, 'Explain the fix briefly', 'local', config);
    assert.deepEqual(provider.calls.map(c => c.model), ['local', 'cloud', 'local']);
    assert.ok(provider.calls[1].messages.some(m => m.role === 'tool' && m.tool_call_id === 'handoff'));
    assert.ok(provider.calls[2].messages.some(m => m.content === 'Cloud diagnosis'));
    assert.equal(f.store.threads(f.dir).length, 1);
  } finally { await f.cleanup(); }
});
test('cloud budget prevents dispatch and manual Local never spills on failure', async () => {
  const f = await fixture(); const provider = new FakeProvider(() => { throw new Error('local unavailable'); });
  const agent = new Agent(f.store, f.dir, f.dir, host, new McpManager(), () => {}, provider);
  try {
    await agent.run(f.thread.id, 'Hello', 'cloud', { ...config, runBudgetUsd: 0 }); assert.equal(provider.calls.length, 0);
    assert.ok(f.store.events(f.thread.id).some(e => e.kind === 'error' && /spending limit/.test(e.payload.text)));
    await agent.run(f.thread.id, 'Hello again', 'local', config); assert.deepEqual(provider.calls.map(c => c.model), ['local']);
  } finally { await f.cleanup(); }
});
test('known credentials are redacted from durable history', async () => {
  const f = await fixture(); const agent = new Agent(f.store, f.dir, f.dir, host, new McpManager(), () => {}, new FakeProvider(() => answer('ok')));
  try { await agent.run(f.thread.id, 'accidentally pasted secret-cloud-key', 'local', config); assert.ok(!JSON.stringify(f.store.events(f.thread.id)).includes('secret-cloud-key')); }
  finally { await f.cleanup(); }
});
test('concurrent runs cannot mutate one workspace at once', async () => {
  const f = await fixture(); let resolve!: (c: Completion) => void;
  const provider = new FakeProvider(() => new Promise(r => { resolve = r; })); const agent = new Agent(f.store, f.dir, f.dir, host, new McpManager(), () => {}, provider);
  const running = agent.run(f.thread.id, 'One', 'local', config);
  try { await assert.rejects(agent.run(f.thread.id, 'Two', 'local', config), /already running/); while (!resolve) await new Promise(r => setTimeout(r, 1)); resolve(answer('done')); await running; }
  finally { await f.cleanup(); }
});
