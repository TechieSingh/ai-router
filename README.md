# ai-router

Notes and one-click launchers for running a local coding model via **[LM Studio](https://lmstudio.ai/)** on a Windows machine with an RTX 3060, used as a free, offline "local" model profile alongside a paid cloud model inside an existing VS Code coding agent.

This project does **not** build its own chat UI, model server, or automatic local/cloud routing — earlier versions of this repo did (a custom VS Code extension, then a hand-rolled llama.cpp launcher), both retired once a mature existing app covered the same job better. All of that is still in git history if worth revisiting.

- **Chat UI, tools, file edits, terminal**: [Cline](https://marketplace.visualstudio.com/items?itemName=saoudrizwan.claude-dev) (or Continue / Roo Code — anything accepting a custom OpenAI-compatible provider).
- **Running the local model, with stats and configuration in a GUI**: LM Studio. It downloads/imports GGUF models, starts/stops an OpenAI-compatible server with one click, and shows live tokens/sec and VRAM usage — everything the old hand-written PowerShell scripts did, with an actual UI.
- **Switching between local and cloud**: manual, via Cline's provider-profile dropdown. Neither app does automatic complexity-based routing out of the box.

## Setup

1. Install LM Studio: `winget install --id ElementLabs.LMStudio`, then launch it once (needed before its `lms` CLI works).
2. Import your GGUF model — if you already have one downloaded, no need to re-download:
   ```
   lms import -y --user-repo "local/qwen3-8b-abliterated" "path\to\model.gguf"
   ```
3. Load it and start the server:
   ```
   lms load qwen3-8b-abliterated --gpu max -c 24576 --identifier local-coder -y
   lms server start
   ```

Endpoint: `http://127.0.0.1:1234/v1`, model identifier `local-coder`.

**Context length note:** LM Studio's default per-model settings didn't match what we'd tuned by hand before (full-precision KV cache instead of quantized), which pushed VRAM to 97% under load — too close to the edge to trust. Without a CLI flag for KV cache quantization, context length is the lever: `-c 24576` measured at **~79% VRAM (9.6 GB) under real sustained generation load**, with ~2.6 GB free. You can likely reclaim room for a larger context by setting KV cache quantization to Q8 in LM Studio's GUI (My Models → gear icon → advanced), the same setting we used to safely run 40,960 tokens by hand — this hasn't been done yet.

**Known follow-up:** LM Studio doesn't disable Qwen3's "thinking" mode by default the way our old raw llama.cpp setup did (which used `chat_template_kwargs: enable_thinking: false`). A quick "PONG" test burned 163 reasoning tokens before answering. Worth disabling via LM Studio's per-model prompt template settings if response speed matters.

### One-click start/stop after a reboot

Run once:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/create-desktop-shortcuts.ps1
```

This adds **Start Local Model** and **Stop Local Model** shortcuts to your Desktop, each running hidden (no console window) via `scripts/start-lmstudio-hidden.vbs` / `stop-lmstudio-hidden.vbs`. Tested end-to-end: Start loads the model and starts the server (ready in a few seconds); Stop stops the server and unloads the model, freeing the GPU.

## Using it from VS Code

Set up **two provider profiles** in Cline and switch between them by hand depending on task complexity:

**Local profile**
- API Provider: OpenAI Compatible
- Base URL: `http://127.0.0.1:1234/v1`
- API Key: any non-empty placeholder (LM Studio doesn't check it)
- Model ID: `local-coder`
- Context Window: `24576`

**Cloud profile**
- API Provider: OpenAI Compatible (or the extension's native provider for your service)
- Base URL / key / model: your paid provider's details
- Context Window: whatever that provider supports

Use Local for short, bounded edits and explanations — it's free and fully offline. Switch to Cloud for anything harder: multi-file refactors, ambiguous debugging, architecture decisions.
