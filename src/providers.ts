import { randomUUID } from 'node:crypto';
import type { Completion, Message, ProviderConfig, ToolCall, ToolDefinition, Usage } from './types';

export function validateEndpoint(base: string) {
  const url = new URL(base);
  if (url.username || url.password) throw new Error('Do not include credentials in API URLs.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('API endpoints require HTTPS, except on loopback.');
  return url;
}
export async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const reader = body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let lines: string[] = [];
  try {
    while (true) {
      const part = await reader.read(); buffer += decoder.decode(part.value, { stream: !part.done });
      if (buffer.length > 2_000_000) throw new Error('Provider stream frame is too large.');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1);
        if (line.startsWith('data:')) lines.push(line.slice(5).trimStart());
        else if (line === '' && lines.length) {
          const data = lines.join('\n'); lines = [];
          if (data === '[DONE]') return;
          yield JSON.parse(data);
        }
      }
      if (part.done) {
        if (buffer.startsWith('data:')) lines.push(buffer.slice(5).trim());
        if (lines.length && lines.join('\n') !== '[DONE]') yield JSON.parse(lines.join('\n'));
        break;
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export class ChatProvider {
  constructor(private fetcher: typeof fetch = fetch) {}
  async complete(config: ProviderConfig, messages: Message[], tools: ToolDefinition[], maxOutput: number, signal: AbortSignal, onText: (text: string) => void): Promise<Completion> {
    validateEndpoint(config.baseUrl);
    const timeout = AbortSignal.timeout(180_000);
    const combined = AbortSignal.any([signal, timeout]);
    const isVenice = new URL(config.baseUrl).hostname === 'api.venice.ai';
    const response = await this.fetcher(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', redirect: 'error', signal: combined,
      headers: { 'Content-Type': 'application/json', ...(config.key ? { Authorization: `Bearer ${config.key}` } : {}) },
      body: JSON.stringify({ model: config.model, messages, tools, tool_choice: 'auto', stream: true, stream_options: { include_usage: true }, max_tokens: maxOutput,
        ...(isVenice ? { venice_parameters: { include_venice_system_prompt: false, enable_web_search: 'off' } } : {}),
        ...(['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.baseUrl).hostname) ? { chat_template_kwargs: { enable_thinking: false } } : {}) })
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Model API HTTP ${response.status}. ${response.status === 401 ? 'Check the saved API key.' : response.status === 429 ? 'Rate limit or account credit limit reached.' : 'Check model ID, context size, and provider availability.'}`);
    }
    if (!response.body) throw new Error('Provider returned no response stream.');
    let content = ''; let finishReason = ''; let usage: Usage | undefined;
    const calls = new Map<number, ToolCall>();
    for await (const chunk of sse(response.body)) {
      if (chunk.error) throw new Error('Provider reported an error during streaming.');
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0]; if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      if (typeof choice.delta?.content === 'string') { content += choice.delta.content; onText(choice.delta.content); }
      for (const delta of choice.delta?.tool_calls ?? []) {
        if (!Number.isInteger(delta.index) || delta.index < 0 || delta.index > 15) throw new Error('Invalid streamed tool index.');
        const call = calls.get(delta.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (delta.id) call.id = delta.id;
        if (delta.function?.name) call.function.name += delta.function.name;
        if (delta.function?.arguments) call.function.arguments += delta.function.arguments;
        if (call.function.arguments.length > 100_000) throw new Error('Tool arguments exceed the supported size.');
        calls.set(delta.index, call);
      }
    }
    if (!finishReason) throw new Error('Model stream ended prematurely. Partial tool calls were not executed.');
    if (!content.trim() && !calls.size) throw new Error('Model returned no visible answer or tool calls. Check the chat template or output token limit.');
    if (calls.size && finishReason !== 'tool_calls' && finishReason !== 'stop') throw new Error('Model tool call was truncated. No tools executed.');
    const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => ({ ...call, id: call.id || randomUUID() }));
    for (const call of toolCalls) { if (!call.function.name) throw new Error('Tool call has no name.'); JSON.parse(call.function.arguments); }
    if (new Set(toolCalls.map(c => c.id)).size !== toolCalls.length) throw new Error('Provider returned duplicate tool call IDs.');
    return { message: { role: 'assistant', content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, usage, finishReason };
  }
}
