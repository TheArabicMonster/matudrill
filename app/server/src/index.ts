import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { createCatalogProvider } from './catalog.js';
import { resolvePaths } from './config.js';
import { Store } from './db.js';

const hostname = process.env.HOST?.trim() || '127.0.0.1';
const port = Number(process.env.PORT ?? 3230);
const paths = resolvePaths();

const catalogProvider = createCatalogProvider(paths.dataDir);
const store = new Store(paths.dbPath);
const app = createApp({
  getCatalog: () => catalogProvider.get(),
  store,
  dataDir: paths.dataDir,
  pdfsDir: paths.pdfsDir,
  appDataDir: paths.appDataDir,
  webDist: paths.webDist,
});

const server = serve({ fetch: app.fetch, hostname, port }, (info) => {
  console.log(`[matudrill] http://${info.address}:${info.port}`);
  console.log(`[matudrill] données : ${paths.dataDir}`);
  console.log(`[matudrill] base    : ${paths.dbPath}`);
  console.log(`[matudrill] PDF     : ${paths.pdfsDir}`);
  console.log(`[matudrill] front   : ${paths.webDist}`);
});

function shutdown(signal: string): void {
  console.log(`[matudrill] ${signal}, arrêt du serveur.`);
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
