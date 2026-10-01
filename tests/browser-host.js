import { createServer as createViteServer } from 'vite';
import { fileURLToPath } from 'node:url';

export function createServer(options = {}) {
  return createViteServer({
    ...options,
    configFile: false,
    root: fileURLToPath(new URL('../', import.meta.url)),
    resolve: { alias: { '/renderer': fileURLToPath(new URL('../src', import.meta.url)) } },
  });
}
