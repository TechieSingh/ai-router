import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import Ajv from 'ajv';
import type { Mode, Settings, ToolDefinition, ToolHost, ToolResult } from './types';
import { Store } from './store';
import { McpManager, childEnvironment } from './mcp';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const blocked = /(^|[\\/])(\.git|node_modules|\.env(?:\.[^\\/]*)?|\.ssh|\.aws|\.runtime)([\\/]|$)|\.(pem|p12|pfx|key)$/i;
function schema(properties: Record<string, unknown>, required = Object.keys(properties)) { return { type: 'object', properties, required, additionalProperties: false }; }
const str = (description: string) => ({ type: 'string', description });
const def = (name: string, description: string, parameters: Record<string, unknown>): ToolDefinition => ({ type: 'function', function: { name, description, parameters } });
export const baseTools = [
  def('list_files', 'List project files. Dependency, Git, and secret paths are excluded.', schema({ path: str('Relative directory, or .') })),
  def('read_file', 'Read a text file and its content hash. Required before editing.', schema({ path: str('Relative path'), start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 } }, ['path'])),
  def('search_files', 'Search project text files for a literal substring.', schema({ query: str('Literal search text') })),
  def('write_file', 'Create or replace a text file after user diff review. Supply hash returned by read_file, or NEW for a new file. Never overwrite changes you have not read.', schema({ path: str('Relative path'), expected_hash: str('SHA256 from read_file or NEW'), content: str('Complete new text') })),
  def('run_terminal', 'Run a command in the project root with user approval. Output and duration are bounded. Shell is PowerShell on Windows. This is not an OS sandbox.', schema({ command: str('Complete shell command') })),
  def('git_diff', 'Read the current unstaged and staged Git diff.', schema({})),
  def('search_history', 'Retrieve original messages from this conversation by literal substring.', schema({ query: str('Search substring') })),
  def('project_memory', 'Read shared project facts or propose a complete replacement for user approval. Do not store secrets or speculative conclusions.', schema({ action: { type: 'string', enum: ['read', 'write'] }, content: str('Complete concise memory for write') }, ['action'])),
  def('escalate', 'Request a stronger cloud model when this task exceeds local capability.', schema({ reason: str('Concrete blocker and work already completed') }))
];
const onlineTools = [
  def('web_fetch', 'Fetch text from a public HTTP(S) URL. Returns the source URL and retrieval time.', schema({ url: str('Public URL') })),
  def('web_search', 'Search the web using the configured Brave Search API key.', schema({ query: str('Search query') })),
  def('discover_mcp', 'List connected MCP tools. Select a few names to load their schemas with enable_mcp.', schema({})),
  def('enable_mcp', 'Load up to five relevant MCP tools for subsequent calls.', schema({ names: { type: 'array', items: { type: 'string' }, maxItems: 5 } }))
];
export async function safePath(root: string, relative: string): Promise<string> {
  if (!relative || path.isAbsolute(relative) || blocked.test(relative)) throw new Error('Use an allowed workspace-relative path.');
  const actualRoot = await fs.realpath(root); const target = path.resolve(actualRoot, relative);
  const within = (p: string) => { const rel = path.relative(actualRoot, p); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
  if (!within(target)) throw new Error('Path escapes the workspace.');
  let probe = target;
  while (true) {
    try { const canonical = await fs.realpath(probe); if (!within(canonical)) throw new Error('Symbolic link escapes the workspace.'); if (blocked.test(path.relative(actualRoot, canonical))) throw new Error('Symbolic link targets a protected path.'); break; }
    catch (e: any) { if (e.code !== 'ENOENT') throw e; const parent = path.dirname(probe); if (parent === probe) throw e; probe = parent; }
  }
  return target;
}
async function files(root: string, dir: string, limit = 600): Promise<string[]> {
  const result: string[] = [];
  async function walk(current: string) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (result.length >= limit) return;
      const full = path.join(current, entry.name); const relative = path.relative(root, full);
      if (blocked.test(relative) || entry.isSymbolicLink() || ['dist', 'build', '.venv', '.next'].includes(entry.name)) continue;
      if (entry.isDirectory()) await walk(full); else result.push(relative);
    }
  }
  await walk(dir); return result;
}
export async function command(commandText: string, root: string, signal: AbortSignal, executable?: string, args?: string[]): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable ?? (process.platform === 'win32' ? 'powershell.exe' : '/bin/sh'), args ?? (process.platform === 'win32' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', commandText] : ['-c', commandText]), { cwd: root, env: childEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let stopped = false;
    const stop = () => { stopped = true; if (process.platform === 'win32' && child.pid) { const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); killer.on('error', () => child.kill()); } else child.kill('SIGTERM'); };
    const timer = setTimeout(stop, 60_000); signal.addEventListener('abort', stop, { once: true });
    const append = (data: Buffer) => { if (output.length < 24000) output += data.toString().slice(0, 24000 - output.length); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => { cleanup(); resolve(`Exit code: ${code}${stopped ? ' (cancelled or timed out; inspect effects before retrying)' : ''}\n${output}\n[Output capped at 24,000 characters]`); });
  });
}
export function isPublicAddress(address: string): boolean {
  if (net.isIP(address) === 6) return /^2[0-9a-f]{3}:/i.test(address) && !/^2001:db8:/i.test(address);
  const [a, b] = address.split('.').map(Number);
  return net.isIP(address) === 4 && a !== 0 && a !== 10 && a !== 127 && a < 224 && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168) && !(a === 100 && b >= 64 && b <= 127);
}
async function publicRequest(url: URL, address: { address: string; family: number }, signal: AbortSignal): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  // Pin the validated DNS result to this connection; a second DNS lookup would permit rebinding.
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), headers: { 'User-Agent': 'JevCodeRouter/0.1', 'Accept-Encoding': 'identity' },
      lookup: ((_hostname: string, options: any, callback: any) => options.all ? callback(null, [address]) : callback(null, address.address, address.family)) as any
    }, response => {
      const chunks: Buffer[] = []; let size = 0;
      const complete = () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') });
      if ((response.statusCode ?? 0) >= 300) { complete(); response.destroy(); return; }
      response.on('data', (chunk: Buffer) => { chunks.push(chunk.subarray(0, Math.max(0, 250_000 - size))); size += chunk.length; if (size >= 250_000) { complete(); response.destroy(); } });
      response.once('end', complete); response.once('error', reject); response.once('aborted', () => reject(new Error('Page transfer interrupted.')));
    });
    request.once('error', reject);
  });
}
export async function fetchPage(input: string, signal: AbortSignal): Promise<string> {
  let url = new URL(input);
  for (let redirects = 0; redirects < 5; redirects++) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new Error('Only public HTTP(S) pages on standard ports are allowed.');
    const addresses = await dns.lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
    if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new Error('Private and local network addresses are not allowed.');
    const response = await publicRequest(url, addresses[0], signal);
    if ([301, 302, 303, 307, 308].includes(response.status)) { if (!response.headers.location) throw new Error('Redirect has no location.'); url = new URL(response.headers.location, url); continue; }
    if (response.status < 200 || response.status >= 300) throw new Error(`Web request HTTP ${response.status}`);
    const type = response.headers['content-type'] ?? '';
    if (!/text\/|json|xml/.test(type)) throw new Error('This tool reads text pages, not binary documents.');
    const raw = response.body;
    const text = /html/.test(type) ? raw.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') : raw;
    return `Source: ${url.href}\nRetrieved: ${new Date().toISOString()}\n${text.slice(0, 16000)}`;
  }
  throw new Error('Too many page redirects.');
}

export class ToolExecutor {
  private enabled: string[] = [];
  private reads = new Map<string, string>();
  private ajv = new Ajv({ strict: false });
  constructor(private root: string, private project: string, private thread: string, private mode: Mode, private settings: Settings, private store: Store, private host: ToolHost, private mcp: McpManager) {}
  definitions(): ToolDefinition[] { return [...baseTools, ...(this.mode === 'offline' ? [] : onlineTools), ...this.mcp.definitions(this.enabled)]; }
  async execute(name: string, args: any, signal: AbortSignal): Promise<ToolResult> {
    signal.throwIfAborted();
    try {
      const tool = this.definitions().find(t => t.function.name === name); if (!tool) throw new Error('Tool is not available in this mode.');
      if (!this.ajv.validate<any>(tool.function.parameters, args)) throw new Error(`Invalid arguments: ${this.ajv.errorsText()}`);
      let content: string;
      if (name.startsWith('mcp_')) {
        if (!await this.host.approve(`Run MCP tool ${name}`, JSON.stringify(args).slice(0, 3000))) throw new Error('MCP call declined.');
        signal.throwIfAborted(); content = await this.mcp.call(name, args, signal);
      } else switch (name) {
        case 'list_files': content = (await files(this.root, await safePath(this.root, args.path))).join('\n'); break;
        case 'read_file': {
          const file = await safePath(this.root, args.path); const stat = await fs.stat(file);
          if (stat.size > 1_000_000) throw new Error('File exceeds 1 MB. Use a narrower external tool.');
          const text = await fs.readFile(file, 'utf8'); if (text.includes('\0')) throw new Error('Binary file is not supported.');
          const digest = hash(text); this.reads.set(file, digest);
          const start = args.start_line ?? 1; const end = args.end_line ?? start + 199;
          content = `SHA256: ${digest}\n` + text.split('\n').slice(start - 1, Math.min(end, start + 399)).map((line, i) => `${start + i}: ${line}`).join('\n'); break;
        }
        case 'search_files': {
          const matches: string[] = [];
          for (const rel of await files(this.root, this.root)) {
            signal.throwIfAborted(); const full = await safePath(this.root, rel); if ((await fs.stat(full)).size > 250000) continue;
            const text = await fs.readFile(full, 'utf8'); if (text.includes('\0')) continue;
            text.split('\n').forEach((line, i) => { if (matches.length < 80 && line.toLowerCase().includes(args.query.toLowerCase())) matches.push(`${rel}:${i + 1}: ${line.slice(0, 200)}`); });
            if (matches.length >= 80) break;
          }
          content = matches.join('\n') || 'No matches.'; break;
        }
        case 'write_file': {
          const file = await safePath(this.root, args.path); let before: string | undefined;
          try { before = await fs.readFile(file, 'utf8'); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
          if (this.host.isDirty(file)) throw new Error('File has unsaved editor changes. Save it before editing.');
          if (before !== undefined && (this.reads.get(file) !== args.expected_hash || hash(before) !== args.expected_hash)) throw new Error('File was not read in this run or changed since it was read. Read again.');
          if (before === undefined && args.expected_hash !== 'NEW') throw new Error('Use NEW for a new file.');
          if (args.content.length > 100_000) throw new Error('Edit exceeds 100,000 characters.');
          if (!this.settings.autoApproveEdits && !await this.host.reviewEdit(file, before ?? '', args.content)) throw new Error('Edit declined.');
          signal.throwIfAborted(); await safePath(this.root, args.path);
          let current: string | undefined; try { current = await fs.readFile(file, 'utf8'); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
          if (current !== before || this.host.isDirty(file)) throw new Error('File changed during review. Read again.');
          await fs.mkdir(path.dirname(file), { recursive: true });
          if (before === undefined) await fs.writeFile(file, args.content, { flag: 'wx' }); else await fs.writeFile(file, args.content);
          this.reads.set(file, hash(args.content)); content = `Updated ${args.path}. SHA256: ${hash(args.content)}`; break;
        }
        case 'run_terminal': {
          if (this.mode === 'offline') throw new Error('Terminal disabled in offline mode because arbitrary commands can access the network.');
          if (!await this.host.approve('Run terminal command', args.command)) throw new Error('Command declined.');
          content = await command(args.command, this.root, signal); break;
        }
        case 'git_diff': content = await command('', this.root, signal, 'git', ['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', '.', ':!.env', ':!.env.*', ':!**/.env', ':!**/.env.*', ':!*.pem', ':!*.key', ':!.ssh/**', ':!.aws/**']); break;
        case 'search_history': content = JSON.stringify(this.store.search(this.thread, args.query)); break;
        case 'project_memory': {
          if (args.action === 'write') {
            if (typeof args.content !== 'string') throw new Error('Memory content is required.');
            if (!await this.host.approve('Update shared project memory', args.content)) throw new Error('Memory update declined.');
            signal.throwIfAborted(); this.store.setMemory(this.project, args.content);
          }
          content = this.store.getMemory(this.project) || 'No shared project memory yet.'; break;
        }
        case 'escalate': content = `Escalation requested: ${args.reason}`; break;
        case 'web_fetch': content = await fetchPage(args.url, signal); break;
        case 'web_search': {
          if (!this.settings.searchKey) throw new Error('Configure a Brave Search key using Configure API Keys, or use web_fetch with a known URL.');
          const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(args.query)}&count=5`, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]), headers: { 'X-Subscription-Token': this.settings.searchKey } });
          if (!response.ok) { await response.body?.cancel(); throw new Error(`Search HTTP ${response.status}`); }
          const body: any = await response.json(); content = JSON.stringify({ retrieved: new Date().toISOString(), results: body.web?.results?.map((r: any) => ({ title: r.title, url: r.url, description: r.description })) ?? [] }); break;
        }
        case 'discover_mcp': content = this.mcp.catalog() || 'No MCP servers connected. Use Connect MCP in the chat toolbar.'; break;
        case 'enable_mcp': this.enabled = args.names; content = `Loaded ${this.mcp.definitions(this.enabled).length} tools.`; break;
        default: throw new Error('Unknown tool');
      }
      return { content: content.length > 16000 ? `${content.slice(0, 16000)}\n[Result truncated; request a narrower range.]` : content,
        failed: (name === 'run_terminal' || name === 'git_diff') ? !content.startsWith('Exit code: 0\n') : name.startsWith('mcp_') ? JSON.parse(content).isError === true : false };
    } catch (e: any) { signal.throwIfAborted(); return { content: `Tool error: ${e.message}`, failed: true }; }
  }
}
