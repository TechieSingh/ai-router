# ai-router

Notes and one-click launchers for running a local coding model via **[LM Studio](https://lmstudio.ai/)** on a Windows machine with an RTX 3060, used as a free, offline "local" model profile alongside a paid cloud model inside an existing VS Code coding agent.

This project does **not** build its own chat UI, model server, or automatic local/cloud routing — earlier versions of this repo did (a custom VS Code extension, then a hand-rolled llama.cpp launcher), both retired once a mature existing app covered the same job better. All of that is still in git history if worth revisiting.

- **Chat UI, tools, file edits, terminal**: [Cline](https://marketplace.visualstudio.com/items?itemName=saoudrizwan.claude-dev) (or Continue / Roo Code — anything accepting a custom OpenAI-compatible provider).
- **Running the local model, with stats and configuration in a GUI**: LM Studio. It downloads/imports GGUF models, starts/stops an OpenAI-compatible server with one click, and shows live tokens/sec and VRAM usage — everything the old hand-written PowerShell scripts did, with an actual UI.
- **Switching between local and cloud**: manual, via Cline's provider-profile dropdown. Neither app does automatic complexity-based routing out of the box.

## Setup

1. Install LM Studio: `winget install --id ElementLabs.LMStudio`, then launch it once (needed before its `lms` CLI works).
2. Import or download a GGUF model. To reuse one you already have (no re-download):
   ```
   lms import -y --user-repo "local/qwen3-8b-abliterated" "path\to\model.gguf"
   ```
   Or download one LM Studio doesn't have in its curated catalog by full Hugging Face URL (repo-shorthand like `owner/repo` only works for catalog picks):
   ```
   lms get "https://huggingface.co/bartowski/Dolphin3.0-Llama3.1-8B-GGUF" -y
   ```
3. **Always unload everything before loading** — see the JIT gotcha below — then load under a fixed identifier and start the server:
   ```
   lms unload --all
   lms load dolphin3.0-llama3.1-8b --gpu max -c 24576 --identifier local-coder -y
   lms server start
   ```

Endpoint: `http://127.0.0.1:1234/v1`, model identifier `local-coder`.

**Currently running: Dolphin3.0-Llama3.1-8B**, not the Qwen3-8B-abliterated model used earlier. Reasons: Dolphin is fine-tuned on curated non-refusal data rather than post-hoc "abliterated" (weight surgery that ablates a refusal direction), so it's more consistent — a live test showed Qwen3-abliterated refusing an edgy prompt outright, a known limitation of abliteration (it reduces refusal, doesn't eliminate it). Dolphin also has no "thinking" overhead: a "reply with PONG" test cost 0 reasoning tokens vs. Qwen3's 163. Qwen3-8B-abliterated is still imported and can be swapped back in any time; just change the model name in the `lms load` command.

**Critical gotcha — JIT auto-loading causes silent duplicate model instances.** LM Studio auto-loads *any* model identifier an API request names, if it isn't already loaded, using LM Studio's own default settings (different context/GPU config than whatever you loaded by hand) under a *different* identifier than the one you chose. This actually happened during setup: testing with a mismatched model name left two full copies of the same 8B model loaded simultaneously, silently doubling VRAM and destabilizing the server. There's no CLI or settings.json flag to disable this (checked `lms server start --help` and `settings.json`'s `jitModelTTL`/`unloadPreviousJITModelOnLoad` keys — no master toggle). The only reliable fix: run `lms unload --all` before every load, and make sure whatever model ID a client (Cline, curl, etc.) requests exactly matches the `--identifier` you loaded with.

**Context length note:** LM Studio's default per-model settings don't match what was tuned by hand for the old raw llama.cpp setup (full-precision KV cache instead of quantized), which pushed VRAM to 97% under load with the Qwen3 model — too close to the edge to trust. Without a CLI flag for KV cache quantization, context length is the lever: `-c 24576` with Dolphin3-8B measured at **~64% VRAM (7.9 GB) under real sustained generation load**. You can likely reclaim room for a larger context by setting KV cache quantization to Q8 in LM Studio's GUI (My Models → gear icon → advanced) — not done yet.

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
