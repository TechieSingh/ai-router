# VS Code local/cloud coding agent plan

Prepared 2026-09-22. Planning only; no models, extensions, services, or dependencies have been installed.

## Outcome and confirmed decisions

Build a VS Code chat assistant that reads, reviews, edits, tests, and researches code. TypeSafe Jev selects a local or paid model. Switching models retains the same conversation, task state, and tool results. Multiple chats have separate histories and share project memory, as confirmed by the user.

Hardware: RTX 3060 with 12,288 MiB VRAM verified with nvidia-smi; about 1,375 MiB was already occupied. CPU and system RAM are user-reported: i5-8600K and 16 GB RAM. Windows system queries could not independently verify those two values.

The realistic target is a comparable coding-agent workflow. Model intelligence, reliability, and product behavior will not automatically match Astra or Opus. No model or provider can credibly guarantee 100% absence of refusals for every possible input. Reduced-refusal models are candidates to evaluate, not a substitute for coding and tool-use benchmarks.

## Architecture

```text
VS Code chat panel: threads, streaming, diffs, Auto / Local / Cloud
                         |
                Local TypeScript agent service
                 /          |              \
       SQLite event log   Context builder   Shared project memory
                            |
                   Capability and budget checks
                            |
                   TypeSafe Jev decision
                     /               \
          llama.cpp on RTX 3060      Venice API
          local 8B GGUF model        paid larger model
                     \               /
                One agent loop and tool executor
                            |
           Files / Git / terminal / MCP / web / browser
                            |
                  Results saved to event log
```

The agent service owns both history and execution. The UI displays the service's event stream. Models propose tool calls; the service validates and executes them and records the results. There must be only one owner of the agent loop.

Use a custom, thin VS Code extension with a webview and a local Node.js/TypeScript service. Share types between the extension and service. SQLite with WAL and FTS5 handles durable events, thread metadata, project facts, and initial text retrieval. Store large logs, screenshots, and attachments as files referenced by content hash.

Cline is a useful optional compatibility prototype: its official documentation supports custom OpenAI-compatible endpoints. It is not the final source of truth in this design. A proxy alone cannot guarantee stable conversation IDs, branch-aware memory, compaction ownership, and exact execution recovery. Avoid building two independent agent loops or depending on a client's undocumented history format. [Cline provider documentation](https://docs.cline.bot/provider-config/openai-compatible)

## Model candidates and hardware settings

| Part | Initial decision | Validation needed |
| --- | --- | --- |
| Inference engine | Native Windows llama.cpp with CUDA | Pin a tested release; verify full GPU offload and tool template |
| Local candidate | Qwen3-8B-abliterated GGUF, Q5_K_M | Coding, structured tool calls, instruction following, and refusal behavior |
| Local comparison | Official Qwen3-8B GGUF | Evaluation baseline; not presented as satisfying the reduced-refusal requirement |
| Paid candidate | Venice `qwen-3-6-plus` | Account availability, tool calls, actual context limits, latency, and coding quality |
| Routing | Direct TypeSafe Jev | Confirm key access, current endpoint schema, and measured routing quality |

The proposed local quantization is approximately 6 GB on disk; total runtime memory also includes context/KV cache and computation buffers. Start at 8K context and test 16K. Use Flash Attention and a supported quantized KV cache if the pinned build and model work correctly. Prefer Q5_K_M; compare Q4_K_M if memory or speed requires it. Keep approximately 1.5-2 GB of VRAM available for the display and variation in other applications. Run one local generation at a time, keeping the model loaded during an active work session. Avoid CPU offload and paging as the normal operating mode. These are tuning starting points, not measured performance claims. [Candidate quantizations](https://huggingface.co/mradermacher/Qwen3-8B-abliterated-GGUF)

A text model is the first coding candidate because vision is not required for file edits, terminal work, or text-based browsing. Route screenshots and image-dependent tasks to the cloud initially. A Qwen3-VL 8B derivative can be benchmarked later if local vision is important, including its vision encoder memory. Do not assume the image's exact local configuration is already validated.

Venice currently lists Qwen 3.6 Plus Uncensored with function calling, vision, coding, and 1000K context. Treat this as provider metadata, not a measured guarantee of useful recall or Astra/Opus-equivalent performance. Its listed privacy category is Anonymized, distinct from Private. Check live model metadata again before implementation. [Venice model catalog](https://docs.venice.ai/models/overview)

llama.cpp supports tool calling through compatible chat templates; verify the derivative's template and parser with actual multi-step tests. [llama.cpp tool documentation](https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md)

## Conversation continuity

Persist an append-only event log keyed by project_id, thread_id, run_id, and event_id. Events include user messages, assistant messages, tool requests, tool results, edits, approvals, routing decisions, failures, usage, and checkpoints. Persist changes transactionally before confirming completion in the UI.

A model switch rebuilds a provider-specific request from the same canonical events. It does not move a chat from one provider to another. Preserve tool-call/result relationships and task objectives. Provider adapters handle role formats, supported modalities, token counting, and structured outputs. Treat provider-specific reasoning blobs as opaque metadata; do not assume internal reasoning or KV caches can transfer between models.

Maintain three distinct layers:

1. Full durable transcript and original artifacts, available for reopening and retrieval.
2. Bounded working context: instructions, active objective, decisions, recent turns, relevant code, and tool results.
3. Shared project memory: conventions, architecture decisions, known issues, and preferences, each with provenance and timestamps.

The working context must fit the selected model after reserving output tokens and accounting for tool definitions and formatting. Compaction creates a new summary artifact with source-event references; it never deletes the original history. Models can retrieve omitted messages and artifacts through tools. Pin explicit user constraints and unresolved tasks independently of generated summaries.

If essential information cannot fit locally, keep the task on the cloud. A million-token cloud conversation cannot be copied verbatim into a 16K local context. Archival preservation is achievable; perfect in-context recall is not.

Shared memory is scoped by project and, where appropriate, branch. Keep contradictory or stale facts identifiable and editable. Re-read current files before edits; memory is not the source of truth for current code. Separate threads do not silently acquire each other's complete transcripts. Allow explicit reference to another thread and retrieval of selected relevant material.

## Jev routing

Jev receives a small routing packet: current request, active objective, selected recent context, likely scope, required capabilities, estimated tokens, local availability, previous failures, and remaining budget. It does not need the full chat or repository. Sensitive text is excluded according to project configuration. Even a locally generated answer can involve sending a routing packet to TypeSafe; offer an offline mode that uses deterministic rules and sends no external requests.

Use Jev Choice to select among eligible local/cloud candidates and other typed questions only where they improve evaluation. Preserve the returned distributions and confidence. The application maps results to a route and an explanation using fixed labels; Jev is not a prose-generating assistant. Its confidence must be calibrated against this task set, not assumed to equal probability of coding success. [TypeSafe introduction](https://docs.typesafe.ai/introduction), [quick start](https://docs.typesafe.ai/introduction/quickstart)

Processing order:

1. Apply explicit Auto / Local / Cloud mode and hard capability, context, privacy, health, and spending constraints.
2. In Auto, ask Jev to select among the remaining viable models.
3. Build the context for the selected model and verify it fits before generation.
4. Hold that choice through the current coherent tool sequence. Reconsider on new user requests, major scope changes, or failure.
5. Escalate after repeated invalid tool calls, a failed bounded repair attempt, context overflow, or unavailable local inference. Hand over objective, current changes, actual test output, and failures.
6. Keep the cloud model through its repair sequence; consider returning locally at the next task boundary.

Use one bounded local repair attempt initially, then tune with measurements. Do not run every hard task locally before routing; that can increase both total cost and latency. Do not rely on a model's self-assessment alone to decide success.

Jev failure has a deterministic fallback: eligible simple tasks stay local; complex tasks use cloud within the configured budget; otherwise pause with a recoverable status. Local mode does not silently spill to cloud. Configure a routing timeout and circuit breaker from measured behavior, starting with a roughly one-second decision deadline for evaluation.

TypeSafe reports 70-500 ms end-to-end response times in its launch post, with geographic and workload caveats. That is vendor-reported, not a promise for this computer. Measure routing and model time-to-first-token separately. Keep requests compact, connections warm, and reuse decisions within a coherent run. Target p95 routing overhead below 500 ms if measurements support it; do not claim instantaneous generation. [TypeSafe launch post](https://typesafe.ai/blog/introducing-system-one-models-and-jev)

## Tools and execution

Start with bounded file reads, search, patch application, Git diff/status, and terminal commands. Add an MCP client supporting configured local stdio and remote HTTP servers. Discover tool schemas, namespace names, validate arguments, and expose only relevant tools to avoid consuming local context with every connected server.

Provide provider-independent web search and page fetching, plus a Playwright browser integration. Select the search backend during implementation based on available credentials and budget. Browser actions and DOM text can work without vision; screenshot interpretation requires a vision-capable route. Record source URLs and retrieval times.

Use workspace path boundaries, secret redaction, operation timeouts, cancellation, and configurable permissions. Store API keys using VS Code SecretStorage or an OS credential store; never put keys in chat, shared memory, or repository files. Bind services to loopback and authenticate local clients. Treat web pages, repository content, and MCP results as data rather than instructions that can change permissions.

Record tool intent before execution and results afterward. Use operation IDs and file hashes to avoid replaying completed edits. An interrupted shell command can have unknown external effects: reconcile or ask before repeating it. Do not promise exactly-once execution for arbitrary external tools. Serialize conflicting writes across chats, detect changes since a file was read, and use isolated worktrees later for simultaneous editing runs.

## Build milestones and acceptance criteria

| Milestone | Deliverable | Exit condition |
| --- | --- | --- |
| 1. Feasibility spike | Local server, paid adapter, Jev adapter, small benchmark harness | Measure VRAM, TTFT, tokens/sec, coding success, tool validity, and routing; pass a read-edit-test task on each model |
| 2. Persistent runtime | SQLite events, provider adapters, context builder, one tool loop | Local-to-cloud-to-local conversation survives restart with objectives, tool results, and edits preserved |
| 3. VS Code product | Sidebar chat, multiple threads, streamed events, diff review, cancel, model controls | Reopen separate threads; switch models in one thread; display actual route and usage |
| 4. Shared memory and integrations | Project facts, retrieval, MCP, web, Playwright | Relevant facts carry across threads; unrelated projects stay isolated; both models use the same tools |
| 5. Reliability and tuning | Recovery, budgets, escalation, concurrency controls, packaged VSIX | Pass failure/restart/overflow/budget tests and meet measured quality/cost goals |

Use 30-50 representative tasks across small changes, tests, debugging, multi-file refactors, and research. Compare local-only, cloud-only, and Jev-routed runs. Hold some tasks out from threshold tuning. Track final correctness, latency, tool failure rate, total cloud cost including retries, and unnecessary escalations. Choose defaults based on successful work per dollar and acceptable response time rather than maximum utilization.

Critical scenarios: route switch after an edit; new model sees actual test failure; long cloud thread returns locally without losing pinned constraints; partial streamed tool call is never executed; interrupted command is not blindly repeated; Jev outage; local OOM; cloud 429; spending cap; thread isolation; conflicting file edits; stale memory; service and VS Code restart.

## Costs and remaining implementation choices

Budget includes local electricity, Jev, paid inference, and potentially web search. API credentials and billing are separate from chat-product subscriptions unless the provider explicitly states otherwise. Add per-run and daily configurable spending caps, output limits, and visible usage before long agent runs.

Choose a daily cloud budget and search backend at setup. Select the final local derivative only after benchmark results. Pin runtime versions, model files and hashes, chat templates, and cloud model IDs. No API key is needed to approve or discuss this plan, and none has been requested here.

Optional future Astra support should use its documented tool-capable API adapter rather than assuming a generic chat endpoint provides every capability. Current OpenAI documentation specifies Responses for Astra tool calling. [Official OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model)
