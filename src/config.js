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
  console.error('Failed to load config.json:', err.message);
  process.exit(1);
}

// Validate required fields
const required = ['service.port', 'storage.dataDir', 'llm.gatewayWsUrl', 'llm.gatewayHttpUrl'];
for (const path of required) {
  const parts = path.split('.');
  let val = config;
  for (const p of parts) val = val?.[p];
  if (val === undefined) {
    console.error(`Missing required config: ${path}`);
    process.exit(1);
  }
}

export { config };
