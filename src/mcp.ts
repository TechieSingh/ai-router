import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Ajv from 'ajv';
import type { McpConfig, ToolDefinition, ToolHost } from './types';
import { validateEndpoint } from './providers';

export function childEnvironment(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'PATHEXT']) if (process.env[key]) result[key] = process.env[key]!;
  return result;
}
export class McpManager {
  private clients: Client[] = [];
  private entries = new Map<string, { client: Client; name: string; definition: ToolDefinition; validate: ReturnType<Ajv['compile']> }>();
  private ajv = new Ajv({ strict: false });
  async connect(configs: McpConfig[], host: ToolHost): Promise<string[]> {
    await this.close(); const statuses: string[] = [];
    for (const config of configs.slice(0, 8)) {
      let client: Client | undefined;
      try {
        if (!/^[a-zA-Z0-9_-]{1,24}$/.test(config.name)) throw new Error('Use a short alphanumeric server name.');
        if (!await host.approve(`Connect MCP: ${config.name}`, config.url ?? `${config.command} ${(config.args ?? []).join(' ')}`)) continue;
        if (config.url) validateEndpoint(config.url);
        else if (!config.command) throw new Error('Server requires command or url.');
        client = new Client({ name: 'jev-code-router', version: '0.1.0' });
        const transport = config.url ? new StreamableHTTPClientTransport(new URL(config.url)) : new StdioClientTransport({ command: config.command!, args: config.args ?? [], env: childEnvironment(), stderr: 'ignore' });
        await client.connect(transport, { timeout: 20_000 }); this.clients.push(client);
        let cursor: string | undefined; let count = 0;
        do {
          const page = await client.listTools({ cursor }, { timeout: 15_000 });
          for (const tool of page.tools) {
            if (++count > 200) break;
            const name = `mcp_${config.name}_${count}`;
            this.entries.set(name, { client, name: tool.name, validate: this.ajv.compile(tool.inputSchema), definition: { type: 'function', function: { name, description: `${config.name}/${tool.name}: ${tool.description ?? ''}`.slice(0, 1200), parameters: tool.inputSchema } } });
          }
          cursor = page.nextCursor;
        } while (cursor && count < 200);
        statuses.push(`${config.name}: ${count} tools connected`);
      } catch (e: any) { if (client) { await client.close().catch(() => {}); for (const [name, entry] of this.entries) if (entry.client === client) this.entries.delete(name); } statuses.push(`${config.name}: ${e.message}`); }
    }
    return statuses;
  }
  catalog(): string { return [...this.entries].map(([id, e]) => `${id}: ${e.definition.function.description}`).join('\n'); }
  definitions(names: string[]): ToolDefinition[] { return names.flatMap(name => this.entries.get(name)?.definition ?? []); }
  async call(name: string, args: any, signal: AbortSignal): Promise<string> {
    const entry = this.entries.get(name); if (!entry) throw new Error('MCP tool is not connected.');
    if (!entry.validate(args)) throw new Error(`Invalid MCP arguments: ${this.ajv.errorsText(entry.validate.errors)}`);
    const result = await entry.client.callTool({ name: entry.name, arguments: args }, undefined, { signal, timeout: 60_000 });
    return JSON.stringify(result);
  }
  async close() { await Promise.allSettled(this.clients.map(c => c.close())); this.clients = []; this.entries.clear(); }
}
