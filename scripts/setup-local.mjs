// Downloads official Windows CUDA binaries and an immutable GGUF revision into this repository.
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, '.runtime');
await fs.mkdir(runtime, { recursive: true });
async function json(url) { const response = await fetch(url); if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`); return response.json(); }
async function digest(file) { const h = createHash('sha256'); for await (const chunk of createReadStream(file)) h.update(chunk); return h.digest('hex'); }
async function download(url, dest, sha) {
  if (!sha || !/^[a-f0-9]{64}$/i.test(sha)) throw new Error(`Missing checksum for ${path.basename(dest)}`);
  if (await fs.stat(dest).catch(() => null)) { if (await digest(dest) === sha) { console.log(`Verified cached ${path.basename(dest)}`); return; } throw new Error(`Checksum mismatch for existing ${dest}. Move it aside and retry.`); }
  const partial = dest + '.partial'; const size = (await fs.stat(partial).catch(() => null))?.size ?? 0;
  console.log(`Downloading ${path.basename(dest)}${size ? ` (resuming at ${size} bytes)` : ''}…`);
  const response = await fetch(url, { headers: size ? { Range: `bytes=${size}-` } : {} });
  if (!response.ok || !response.body) throw new Error(`Download HTTP ${response.status}`);
  const resume = response.status === 206; let total = resume ? size : 0; let last = Date.now();
  const stream = Readable.fromWeb(response.body);
  stream.on('data', chunk => { total += chunk.length; if (Date.now() - last > 10000) { console.log(`${path.basename(dest)}: ${(total / 1e9).toFixed(2)} GB`); last = Date.now(); } });
  await pipeline(stream, createWriteStream(partial, { flags: resume ? 'a' : 'w' }));
  if (await digest(partial) !== sha) throw new Error(`Checksum mismatch: ${partial}`);
  await fs.rename(partial, dest); console.log(`Verified ${path.basename(dest)}`);
}
const release = await json('https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/b10964');
const binDir = path.join(runtime, 'llama-b10964'); await fs.mkdir(binDir, { recursive: true });
for (const assetName of ['llama-b10964-bin-win-cuda-12.4-x64.zip', 'cudart-llama-bin-win-cuda-12.4-x64.zip']) {
  const asset = release.assets.find(a => a.name === assetName); if (!asset) throw new Error(`Release asset missing: ${assetName}`);
  const zip = path.join(runtime, assetName); await download(asset.browser_download_url, zip, asset.digest?.replace('sha256:', ''));
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const expanded = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(binDir)} -Force`], { windowsHide: true, stdio: 'inherit' });
  if (expanded.status !== 0) throw new Error('Archive extraction failed.');
}
async function findServer(dir) { for (const entry of await fs.readdir(dir, { withFileTypes: true })) { const p = path.join(dir, entry.name); if (entry.name === 'llama-server.exe') return p; if (entry.isDirectory()) { const found = await findServer(p); if (found) return found; } } }
const llamaServer = await findServer(binDir); if (!llamaServer) throw new Error('llama-server.exe not found.');
const repo = 'mradermacher/Qwen3-8B-abliterated-GGUF';
const metadata = await json(`https://huggingface.co/api/models/${repo}?blobs=true`);
const model = metadata.siblings.find(f => /Q5_K_M\.gguf$/i.test(f.rfilename)); if (!model?.lfs?.sha256) throw new Error('Q5_K_M artifact or checksum missing.');
const modelPath = path.join(runtime, path.basename(model.rfilename));
await download(`https://huggingface.co/${repo}/resolve/${metadata.sha}/${model.rfilename}?download=true`, modelPath, model.lfs.sha256);
const manifest = { llamaVersion: release.tag_name, llamaServer, modelPath, modelRepo: repo, modelRevision: metadata.sha, sha256: model.lfs.sha256, context: 8192, downloaded: new Date().toISOString() };
await fs.writeFile(path.join(runtime, 'local-model.json'), JSON.stringify(manifest, null, 2));
console.log('Ready. Run: powershell -ExecutionPolicy Bypass -File scripts/start-local.ps1');
