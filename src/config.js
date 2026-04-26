import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, '..', 'config.json');

let config;

try {
  const raw = fs.readFileSync(configPath, 'utf8');
  config = JSON.parse(raw);
} catch (err) {
  // Can't use logger here - logger depends on config
  console.error('Failed to load config.json:', err.message);
  process.exit(1);
}

// Validate required fields
const required = ['service.port', 'storage.dataDir'];
for (const pathStr of required) {
  const parts = pathStr.split('.');
  let val = config;
  for (const p of parts) val = val?.[p];
  if (val === undefined) {
    // Can't use logger here - logger depends on config
    console.error(`Missing required config: ${pathStr}`);
    process.exit(1);
  }
}

if (!config.llama) {
  config.llama = {
    port: 42718,
    modelPath: 'bin/llama/models/jina-embeddings-v2-base-code-Q5_K_M.gguf',
    ctxSize: 8192,
    concurrencyLimit: 50
  };
}

if (!config.llm) config.llm = {};
if (!config.llm.provider) config.llm.provider = 'local';
if (!config.llm.maxConcurrentRequests) config.llm.maxConcurrentRequests = 100;

const projectRoot = path.join(__dirname, '..');

if (!config.storage.trashDir) {
  config.storage.trashDir = path.join(projectRoot, 'data', 'trash');
}

if (config.discovery?.roots) {
  config.discovery.roots = config.discovery.roots.map(r => r.replace(/\/$/, '').replace(/\\$/, ''));
}

export { config };
