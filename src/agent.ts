import { randomUUID } from 'node:crypto';
import type { AgentUpdate, Message, Mode, Route, Settings, ToolHost } from './types';
import { Store } from './store';
import { ChatProvider } from './providers';
import { chooseRoute } from './router';
import { buildContext, ContextOverflow, estimateTokens } from './context';
import { McpManager } from './mcp';
import { ToolExecutor } from './tools';

export class Agent {
  private controller?: AbortController;
  private activeThread?: string;
  constructor(readonly store: Store, private root: string, private project: string, private host: ToolHost, readonly mcp: McpManager, private emit: (update: AgentUpdate) => void, private provider = new ChatProvider(), private router = chooseRoute) {}
  get busy() { return Boolean(this.controller); }
  get runningThread() { return this.activeThread; }
  cancel() { this.controller?.abort(new Error('Cancelled by user.')); }
  async run(thread: string, prompt: string, mode: Mode, settings: Settings): Promise<void> {
    if (this.busy) throw new Error('A task is already running. Stop it before starting another.');
    if (!prompt.trim() || prompt.length > 100_000) throw new Error('Enter a prompt of at most 100,000 characters.');
    if (this.store.thread(thread).project !== this.project) throw new Error('Conversation belongs to a different project.');
    const redact = (value: string): string => [settings.cloud.key, settings.local.key, settings.jevKey, settings.searchKey].filter((s): s is string => Boolean(s)).reduce((text, secret) => text.split(secret).join('[REDACTED]'), value);
    const controller = new AbortController(); this.controller = controller; this.activeThread = thread;
    const signal = controller.signal; const run = randomUUID();
    const record = (kind: string, payload: any) => { const event = this.store.append(thread, run, kind, JSON.parse(redact(JSON.stringify(payload)))); this.emit({ type: 'event', thread, event }); };
    const status = (text: string) => record('status', { text });
    let outcome = 'failed';
    try {
      record('run_started', { mode });
      if (!this.store.messages(thread).length) this.store.rename(thread, redact(prompt).slice(0, 60));
      record('message', { role: 'user', content: redact(prompt) });
      status(mode === 'auto' ? 'Selecting a model with Jev…' : 'Preparing context…');
      let route = await this.router(mode, this.store.messages(thread), settings, signal); record('route', route);
      const tools = new ToolExecutor(this.root, this.project, thread, mode, settings, this.store, this.host, this.mcp);
      let failures = 0;
      const escalate = (reason: string) => {
        if (mode !== 'auto' || route.target === 'cloud' || !settings.cloud.key) return false;
        route = { target: 'cloud', source: 'constraint', reason, latencyMs: 0 }; record('route', route); return true;
      };
      for (let step = 0; step < settings.maxSteps; step++) {
        signal.throwIfAborted();
        const config = settings[route.target]; const definitions = tools.definitions();
        let context;
        try { context = buildContext(this.store.messages(thread), this.store.getMemory(this.project), definitions, config.context, settings.maxOutputTokens); }
        catch (e) { if (e instanceof ContextOverflow && escalate('Active context exceeds the local model budget.')) { step--; continue; } throw e; }
        if (context.omitted) record('context', { omitted: context.omitted, text: 'Older turns remain in history and can be retrieved with search_history.' });
        let reservation: string | undefined;
        if (route.target === 'cloud') {
          const upperInput = Buffer.byteLength(JSON.stringify([context.messages, definitions]), 'utf8');
          const upperCost = (upperInput * settings.inputPricePerMillion + settings.maxOutputTokens * settings.outputPricePerMillion) / 1_000_000;
          if (this.store.spent() + upperCost > settings.dailyBudgetUsd || this.store.spent(run) + upperCost > settings.runBudgetUsd) throw new Error('Estimated cloud spending limit reached. Adjust the budget in settings or continue with Local.');
          reservation = this.store.reserve(run, upperCost);
        }
        status(`${route.target === 'local' ? 'Local' : 'Cloud'} · ${config.model} · step ${step + 1}`);
        let completion;
        try {
          completion = await this.provider.complete(config, context.messages, definitions, settings.maxOutputTokens, signal, text => this.emit({ type: 'delta', thread, text: redact(text) }));
        } catch (e: any) {
          this.emit({ type: 'reset', thread }); signal.throwIfAborted();
          // Keep cloud reservation on unknown/failed streams: the provider may have billed tokens.
          if (escalate(`Local model unavailable or failed: ${redact(e.message)}`)) { step--; continue; }
          throw e;
        }
        if (reservation && completion.usage && Number.isFinite(completion.usage.prompt_tokens) && Number.isFinite(completion.usage.completion_tokens) && completion.usage.prompt_tokens >= 0 && completion.usage.completion_tokens >= 0) {
          const amount = (completion.usage.prompt_tokens * settings.inputPricePerMillion + completion.usage.completion_tokens * settings.outputPricePerMillion) / 1_000_000;
          this.store.settle(reservation, amount); record('usage', { ...completion.usage, estimatedUsd: amount });
        } else if (reservation) record('usage', { estimated: true, text: 'Provider omitted token usage; conservative cost reservation retained.' });
        record('message', completion.message);
        const calls = completion.message.tool_calls;
        if (!calls?.length) {
          if (completion.finishReason === 'length') status('Response reached its output limit. Ask to continue or raise max output tokens.');
          outcome = 'complete'; break;
        }
        let requestedEscalation = '';
        for (const call of calls) {
          signal.throwIfAborted(); record('tool_started', { id: call.id, name: call.function.name, arguments: call.function.arguments });
          const args = JSON.parse(call.function.arguments);
          const result = await tools.execute(call.function.name, args, signal);
          if (call.function.name === 'escalate') {
            requestedEscalation = args.reason;
            if (mode !== 'auto' || route.target === 'cloud' || !settings.cloud.key) result.content = 'Escalation is unavailable in this mode or model. Explain the blocker to the user without repeating this call.';
          }
          record('message', { role: 'tool', tool_call_id: call.id, content: result.content });
          record('tool_finished', { id: call.id, name: call.function.name, failed: result.failed ?? false });
          failures = result.failed ? failures + 1 : 0;
        }
        if (requestedEscalation) escalate(`Model requested escalation: ${requestedEscalation}`);
        else if (failures >= 2) escalate('Repeated local tool failures; cloud will inspect the existing results.');
        if (step === settings.maxSteps - 1) { status('Step limit reached. Work is saved; send a follow-up to continue.'); outcome = 'paused'; }
      }
    } catch (e: any) {
      outcome = signal.aborted ? 'cancelled' : 'failed';
      this.store.closePendingTools(thread, run, 'Execution was interrupted. Inspect actual workspace state before retrying; effects may be unknown.');
      record('error', { text: redact(signal.aborted ? 'Task stopped. Completed actions and history are saved.' : e.message) });
    } finally {
      record('run_finished', { status: outcome, estimatedUsd: this.store.spent(run) });
      this.controller = undefined; this.activeThread = undefined; this.emit({ type: 'status', thread, text: 'idle' });
    }
  }
}
