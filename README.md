# Jev Code Router

A VS Code coding assistant with one persistent conversation across local and cloud models. Separate chats share an editable project memory. Jev selects the model in Auto mode.

## Start here

1. Install `jev-code-router-0.1.0.vsix` in VS Code using **Extensions: Install from VSIX**.
2. Open a trusted project folder and click the **Jev Router** activity-bar icon.
3. Start the local model using the commands below. Select **Local** in chat for a first conversation.
4. Click **Keys** and save your **TypeSafe Jev** and **Cloud provider / Venice** API keys. Keys go into VS Code SecretStorage, never into this repository.
5. Click **Connections** to check the local endpoint and cloud model catalog. Select **Auto · Jev** to enable routing.

For development, run `npm ci`, `npm run check`, then press **F5** to open an Extension Development Host. The first workspace folder is the project boundary; use one folder per VS Code window. VS Code 1.90+ and Node 20+ are the declared minimums.

## Local model on Windows / RTX 3060 12 GB

```powershell
npm run setup:local
powershell -ExecutionPolicy Bypass -File scripts/start-local.ps1
```

Setup downloads approximately 6.5 GB into `.runtime`, verifies SHA256 checksums, and records the model's immutable revision. It uses llama.cpp b10964 CUDA 12.4 and the Q5_K_M quantization of `mradermacher/Qwen3-8B-abliterated-GGUF`. Partial downloads resume when supported. The source is a reduced-refusal derivative, not a guarantee that every request will be answered or that its coding ability matches a frontier model.

The launcher runs hidden with a 16K context by default, one generation slot, full GPU offloading, Flash Attention, and Q8 KV cache. It binds only to `127.0.0.1:8080`, with model alias `local-coder`. Wait for loading to finish, then click **Connections**. Logs are `.runtime/local.stdout.log` and `.runtime/local.stderr.log`. Active local requests disable thinking through llama.cpp's chat-template option.

Measured on a 12 GB RTX 3060: 8K context uses about 6.9 GB VRAM, 16K about 7.5 GB — both leave comfortable headroom for Windows and the display. 32K (this model's native training context) jumps to about 11.9 GB, leaving under 500 MB free, which is too tight to run reliably alongside anything else; that is why 16K, not 32K, is the shipped default. To fall back to 8K, start with `-Context 8192` and change **Jev Router: Local Context** to match. System RAM is not interchangeable with VRAM.

```powershell
npm run test:local
powershell -ExecutionPolicy Bypass -File scripts/stop-local.ps1
```

The local smoke test edits only its own `.runtime/smoke-project/greeting.ts` fixture, records timings and GPU memory, and saves `.runtime/local-smoke-result.json`.

## Chat modes

| Mode | Behavior |
| --- | --- |
| Auto · Jev | Routes each new task with Jev; holds the route through its tool sequence; can escalate after local failures or context overflow |
| Local | Local generation only; no silent paid fallback. Web and explicitly approved tools can still use the network |
| Cloud | Uses the configured paid model throughout the run |
| Offline | Loopback model only; no Jev, web, MCP, or arbitrary terminal commands. File tools and Git diff remain available |

The default cloud endpoint is Venice with model `qwen-3-6-plus`. Set another OpenAI-compatible provider through **Settings**, including its model, context limit, and prices. This version implements Chat Completions with structured tool calls; provider-specific Responses APIs and image attachments are not implemented.

Auto requires a Jev key when both candidates are available. If Jev times out, the recorded route clearly identifies the fallback. Jev receives a compact task/context packet even when it chooses local generation. Offline avoids that external request. Jev confidence thresholds are initial heuristics, not calibrated coding-success probabilities.

## History and memory

Each thread persists messages, tool calls and results, routing, usage, and run status in a workspace-scoped SQLite file under VS Code's extension storage. It survives model switches and restarts. A lock prevents two windows from concurrently opening the same database. Interrupted tools receive an explicit unknown-outcome record and are never automatically replayed.

Working context includes the initial objective, shared memory, and recent complete turns. If older turns do not fit, they remain in the database and are available through `search_history`; the UI displays that omission. The current active turn is never silently dropped. Auto can move an oversized active task to cloud; manual Local reports the limit. Token counting is conservative estimation, not a provider tokenizer guarantee. There is no claim of lossless model recall or transferable hidden reasoning.

Click **Memory** to edit durable project facts. The agent may propose memory changes, but they require review. Memory is shared between threads in this project, while transcripts remain separate. Cross-project memory is isolated. Branch-scoped memories, semantic indexing, and automatic summarization are follow-up work.

Persistence uses SQLite via sql.js and atomic file snapshots, avoiding native-module ABI issues in VS Code. This first version supports one running task per workspace and does not use WAL or a standalone server. Large-history storage optimization can come later without changing the event schema.

## Tools

- Files: list, literal search, bounded reads, and reviewed whole-file edits. Existing files must be read first; content hashes and unsaved-buffer checks prevent stale overwrites.
- Terminal: PowerShell on Windows; approval per command, bounded output, cancellation, and a 60-second timeout. Commands are **not OS-sandboxed** and can act outside the workspace once approved.
- Git: current staged/unstaged diff against HEAD; requires a repository with a commit.
- History and project memory: retrieve older conversation records and share explicit durable facts.
- Web: public page fetching and optional Brave Search. Save the Brave API key through **Keys**. Source URLs and retrieval timestamps are returned to the model.
- MCP: configured stdio and Streamable HTTP servers, discovery, argument validation, and per-call approval. The model loads only a few tool schemas at a time.

## MCP and browser setup

Add trusted servers in your **user settings**, then click **MCP** to connect. Connections require approval each VS Code session. Example for a Playwright browser:

```json
{
  "jevRouter.mcpServers": [
    {
      "name": "browser",
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest", "--headless", "--isolated"]
    }
  ]
}
```

The first run downloads that MCP package; install its required browser if the server reports one missing. Pin a tested server version for long-term use. Any other trusted stdio server uses the same shape; remote servers use `{ "name": "docs", "url": "https://your-server.example/mcp" }`. Authenticated remote MCP/OAuth and arbitrary server environment injection are not implemented. Never embed keys in URLs or arguments. Browser DOM tools work with the text model; image-based browser reasoning needs a future vision adapter.

## Spending and permissions

Default estimated cloud limits are **$1 per run** and **$5 per UTC day**. The configured initial price estimate is $0.63/M input tokens and $3.75/M output tokens. Update prices when switching providers or models. A conservative reservation is made before each cloud call and reconciled if token usage is returned. Failed or cancelled calls retain the reservation because billing may have occurred. These are application estimates, not provider-enforced billing caps, and exclude Jev, search, and MCP charges. Use the provider's account limits as well.

File edits show a VS Code diff before application. Terminal and MCP calls require approval. `autoApproveEdits` is an opt-in user setting. File tools reject traversal, external symlinks, common secret paths, and dependency directories; arbitrary approved terminal/MCP tools have their own authority. Known configured keys are redacted from durable records. There is no comprehensive secret-detection guarantee for arbitrary source files or external tool output.

## Verification and packaging

```powershell
npm run check
npm run test:ui
npm run package
code --install-extension .\jev-code-router-0.1.0.vsix
```

The core tests cover handoff continuity, persistence, recovery, budget limits, streaming truncation, credential redaction, path containment, stale edits, and thread isolation. Integration tests use real local HTTP and MCP transports with deterministic fixtures. The UI test uses a hidden Microsoft Edge instance; change the Playwright channel if Edge is unavailable. Live Jev/Venice authentication and model quality require your own keys and are separate from the automated tests.

Implementation references: [TypeSafe API](https://docs.typesafe.ai/introduction/quickstart), [Venice chat API](https://docs.venice.ai/api-reference/endpoint/chat/completions), [llama.cpp tool calling](https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md), [VS Code webviews](https://code.visualstudio.com/api/extension-guides/webview), [MCP client documentation](https://modelcontextprotocol.io/docs/develop/build-client).
