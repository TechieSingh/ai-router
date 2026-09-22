import './build.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// Stage only distributable files. Do not scan model downloads or VS Code test profiles.
const stage = path.resolve('.runtime', 'package'); await fs.mkdir(stage, { recursive: true });
const manifest = JSON.parse(await fs.readFile('package.json', 'utf8'));
delete manifest.scripts; delete manifest.devDependencies; delete manifest.dependencies; delete manifest.overrides;
await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2));
for (const file of ['README.md', 'LICENSE']) await fs.copyFile(file, path.join(stage, file));
for (const dir of ['dist', 'media']) { await fs.mkdir(path.join(stage, dir), { recursive: true }); for (const file of await fs.readdir(dir)) await fs.copyFile(path.join(dir, file), path.join(stage, dir, file)); }
const result = spawnSync(process.execPath, [path.resolve('node_modules', '@vscode', 'vsce', 'vsce'), 'package', '--no-dependencies', '--allow-missing-repository', '--out', path.resolve(`${manifest.name}-${manifest.version}.vsix`)], { cwd: stage, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
