export type Mode = 'auto' | 'local' | 'cloud' | 'offline';
export type Target = 'local' | 'cloud';
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface Message { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }
export interface ToolDefinition { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface Usage { prompt_tokens: number; completion_tokens: number }
export interface Completion { message: Message; usage?: Usage; finishReason: string }
export interface ProviderConfig { baseUrl: string; model: string; context: number; key?: string }
export interface Settings {
  local: ProviderConfig; cloud: ProviderConfig; jevKey?: string; searchKey?: string;
  maxOutputTokens: number; maxSteps: number; dailyBudgetUsd: number; runBudgetUsd: number;
  inputPricePerMillion: number; outputPricePerMillion: number; jevTimeoutMs: number;
  autoApproveEdits: boolean; mcpServers: McpConfig[];
}
export interface McpConfig { name: string; command?: string; args?: string[]; url?: string }
export interface Route { target: Target; reason: string; source: 'manual' | 'jev' | 'fallback' | 'constraint'; latencyMs: number; confidence?: number }
export interface Thread { id: string; project: string; title: string; created: string }
export interface Event { id: number; thread: string; run: string; kind: string; payload: any; created: string }
export interface ToolResult { content: string; failed?: boolean }
export interface ToolHost {
  approve(title: string, detail: string): Promise<boolean>;
  reviewEdit(path: string, before: string, after: string): Promise<boolean>;
  isDirty(path: string): boolean;
}
export interface AgentUpdate { type: 'event' | 'delta' | 'status' | 'reset'; thread: string; event?: Event; text?: string }
