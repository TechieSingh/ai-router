# ai-router

Scripts that set up and run a local coding model (llama.cpp + Qwen3-8B) on a Windows machine with an RTX 3060, so it can be used as a free, offline "local" model profile alongside a paid cloud model inside an existing VS Code coding agent.

This project does **not** build its own chat UI, tool execution, or automatic local/cloud routing. Earlier versions of this repo did — a full custom VS Code extension with a webview chat panel, SQLite history, file/terminal/MCP tools, and a Jev-based routing proxy. That code was retired in favor of using an already-mature agent extension (**[Cline](https://github.com/cline/cline)**, or any similar OpenAI-compatible agent like Continue or Roo Code) for the actual chat/tools/UI, and switching between local and cloud **manually** rather than automatically. The old approach is still in this repo's git history if you ever want to revisit it.

## What's here

- `scripts/setup-local.mjs` — downloads llama.cpp (CUDA build) and a quantized Qwen3-8B GGUF into `.runtime/`, with checksum verification and resumable downloads. No npm dependencies required.
- `scripts/start-local.ps1` / `scripts/stop-local.ps1` — start/stop the local `llama-server` process, bound to `127.0.0.1:8080` only.

## Setup

```powershell
node scripts/setup-local.mjs
powershell -ExecutionPolicy Bypass -File scripts/start-local.ps1
```

This downloads llama.cpp b10964 (CUDA 12.4) and the Q5_K_M quantization of `mradermacher/Qwen3-8B-abliterated-GGUF` (~6.5 GB) into `.runtime/`. The source is a reduced-refusal derivative, not a guarantee that every request will be answered or that its coding ability matches a frontier model.

The launcher runs hidden, with:
- **40,960-token context** — this model's native training ceiling. Going higher requires RoPE/YaRN scaling, which this llama.cpp build (b10964) hard-caps back down to 40,960 regardless of what you request, and which trades output quality for context beyond the model's training window in any case.
- Full GPU offload, Flash Attention, Q8 KV cache, and an 8192/4096 batch/ubatch size.

Measured on a 12 GB RTX 3060 under real sustained generation load: **~10.3 GB VRAM (84%)**, leaving about 2 GB free for Windows/display. Full-precision (`f16`) KV cache was also tested and reaches 97% VRAM with llama.cpp's own loader warning it may not fit reliably — too close to the edge, so it isn't used. To use a smaller context, edit the `-Context` value in `start-local.ps1` (`8192` or `16384` also work).

Endpoint: `http://127.0.0.1:8080/v1`, model alias `local-coder`. Logs: `.runtime/local.stdout.log` / `.runtime/local.stderr.log`.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/stop-local.ps1
```

## Using it from VS Code

Install an agentic coding extension that supports a custom OpenAI-compatible provider — [Cline](https://marketplace.visualstudio.com/items?itemName=saoudrizwan.claude-dev) is a good default; Continue and Roo Code also work the same way. Set up **two provider profiles** and switch between them by hand depending on task complexity:

**Local profile**
- API Provider: OpenAI Compatible
- Base URL: `http://127.0.0.1:8080/v1`
- API Key: any non-empty placeholder (the local server doesn't check it)
- Model ID: `local-coder`
- Context Window: `40960`

**Cloud profile**
- API Provider: OpenAI Compatible (or the extension's native provider for your service)
- Base URL / key / model: your paid provider's details
- Context Window: whatever that provider supports

Use Local for short, bounded edits and explanations — it's free and fully offline. Switch to Cloud for anything harder: multi-file refactors, ambiguous debugging, architecture decisions. There is no automatic routing between them; you decide per task.
