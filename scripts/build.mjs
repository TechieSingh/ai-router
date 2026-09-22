import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', bundle: true, platform: 'node', target: 'node20', format: 'cjs', external: ['vscode', 'sql.js'], sourcemap: true });
await copyFile('node_modules/sql.js/dist/sql-wasm.wasm', 'dist/sql-wasm.wasm');
await copyFile('node_modules/sql.js/dist/sql-wasm.js', 'dist/sql-wasm.cjs');
