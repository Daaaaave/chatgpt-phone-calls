import { mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

const project_id = process.env.SITE_PROJECT_ID;
if (!project_id?.trim()) throw new Error('Set SITE_PROJECT_ID to your own private ChatGPT Site project ID.');
const root = new URL('../', import.meta.url);
const dist = new URL('dist/', root);
await mkdir(new URL('.openai/', dist), { recursive: true });
await build({
  entryPoints: [new URL('site/worker.mjs', root).pathname],
  outfile: new URL('server/index.js', dist).pathname,
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
});
await writeFile(new URL('.openai/hosting.json', dist),
  JSON.stringify({ project_id, capabilities: ['mcp'], d1: 'DB', r2: null }, null, 2) + '\n');
