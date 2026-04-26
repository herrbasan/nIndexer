/**
 * nIndexer MCP stdio Transport Server
 * 
 * Invoked by AI assistants like Claude Desktop that communicate via
 * standard input/output JSON-RPC instead of SSE/HTTP.
 */

// Force all console logs to stderr to prevent corrupting the JSON-RPC stdout stream
process.env.MCP_STDIO = 'true';
const _originalLog = console.log;
const _originalInfo = console.info;
console.log = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);

import readline from 'readline';
import { config } from './config.js';
import { LLMClient } from './llm-client.js';
import { init as initIndexingService } from './services/indexing.service.js';
import { DiscoveryService } from './services/discovery.service.js';
import { handleMcpMessage } from './api/mcp-router.js';
import { getLogger } from './utils/logger.js';

const logger = getLogger();

let llmClient;
let indexingService;
let discoveryService;

async function startStdioServer() {
  logger.info(`Starting nIndexer MCP stdio Transport...`);
  
  try {
    llmClient = new LLMClient();

    const serviceConfig = {
      ...config.indexing,
      trashDir: config.storage.trashDir,
      spaces: config.spaces,
      maintenance: config.maintenance
    };
    
    indexingService = await initIndexingService({
      config: { codebase: serviceConfig },
      gateway: llmClient
    });

    if (config.discovery?.roots?.length > 0) {
      discoveryService = new DiscoveryService(indexingService, config.discovery);
      indexingService.maintenance.setDiscoveryService(discoveryService);
      discoveryService.start();
    }

    logger.info(`Indexing Service Initialized. Ready for JSON-RPC messages on stdin.`);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false
    });

    const session = {
      send: (msg) => {
        // Send JSON-RPC response strictly exactly as a single line on stdout
        process.stdout.write(JSON.stringify(msg) + '\n');
      }
    };

    rl.on('line', async (line) => {
      if (!line || !line.trim()) return;
      try {
        const message = JSON.parse(line);
        await handleMcpMessage(message, session, indexingService);
      } catch (err) {
        logger.error('Failed to parse incoming MCP stdio message', err, { line }, 'MCP');
        // Only emit error if we could parse an ID, but JSON parse means we have no ID
        // Generally MCP stdio drops malformed JSON lines silently
      }
    });

    rl.on('close', () => {
      logger.info(`MCP stdio session closed. Exiting.`);
      process.exit(0);
    });

  } catch (err) {
    logger.error(`Critical error starting stdio transport`, err);
    process.exit(1);
  }
}

// Start
startStdioServer();
