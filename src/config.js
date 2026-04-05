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

// Set default LLM URLs if not configured
if (!config.llm) config.llm = {};
if (!config.llm.gatewayWsUrl) config.llm.gatewayWsUrl = 'ws://localhost:3400/v1/realtime';
if (!config.llm.gatewayHttpUrl) config.llm.gatewayHttpUrl = 'http://localhost:3400';

// Set default logs directory if not configured
if (!config.logs?.dir) {
  if (!config.logs) config.logs = {};
  config.logs.dir = path.join(__dirname, '..', 'logs');
}

export { config };
