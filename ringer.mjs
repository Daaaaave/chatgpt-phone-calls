import { pathToFileURL } from 'node:url';
import { runCli } from './caller.mjs';

export { createCaller as createRinger, serveCloud } from './caller.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
