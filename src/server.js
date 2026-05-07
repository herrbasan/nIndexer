/**
 * nIndexer WebSocket Server
 *
 * Native Node.js HTTP + WebSocket server (no external dependencies).
 * Implements WebSocket handshake manually using built-in crypto and http modules.
 */

import http from 'http';
import { randomUUID } from 'crypto';
import { config } from './config.js';
import { LLMClient } from './llm-client.js';
import { init as initIndexingService, shutdown as shutdownIndexingService } from './services/indexing.service.js';
import { DiscoveryService } from './services/discovery.service.js';
import { handleMcpMessage } from './api/mcp-router.js';
import { getLogger } from './utils/logger.js';

const HOST = config.service.host;
const PORT = config.service.port;

const logger = getLogger();

let server;
let llmClient;
let indexingService;
let discoveryService;

// Per-session SSE state: Map<sessionId, { res, send }>
const sessions = new Map();

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function main() {
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

  // Load statically configured codebases (non-blocking)
  if (config.codebases && Object.keys(config.codebases).length > 0) {
    (async () => {
      const existing = await indexingService.listCodebases();
      const existingNames = new Set(existing.map(cb => cb.name));
      for (const [name, source] of Object.entries(config.codebases)) {
        if (existingNames.has(name)) continue;
        try {
          await indexingService.indexCodebase({ name, source });
          logger.info(`Static codebase indexed`, { name, source }, 'Server');
        } catch (err) {
          logger.error(`Failed to index static codebase`, err, { name, source }, 'Server');
        }
      }
    })();
  }

  if (config.discovery?.roots?.length > 0) {
    discoveryService = new DiscoveryService(indexingService, config.discovery, config.codebases);
    indexingService.maintenance.setDiscoveryService(discoveryService);
    discoveryService.start();
  }

  server = http.createServer((req, res) => {
    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      return res.end();
    }

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', service: 'nIndexer-MCP' }));
    }

    // MCP Server-Sent Events Initialization
    if (req.method === 'GET' && req.url === '/mcp/sse') {
      const sessionId = randomUUID();
      logger.info(`New MCP SSE session connected`, { sessionId }, 'MCP');

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
      });

      res.write(`event: endpoint\ndata: /mcp/message?sessionId=${sessionId}\n\n`);

      const send = (msg) => {
        try {
          sseWrite(res, 'message', msg);
        } catch (err) {
          logger.error('Failed to send SSE message', err, { sessionId }, 'MCP');
        }
      };
      sessions.set(sessionId, { res, send });

      req.on('close', () => {
        logger.info(`MCP Session disconnected`, { sessionId }, 'MCP');
        sessions.delete(sessionId);
      });
      return;
    }

    // MCP JSON-RPC Message Receiver
    if (req.method === 'POST' && req.url.startsWith('/mcp/message')) {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const sessionId = url.searchParams.get('sessionId');
      
      const session = sessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Session not found');
      }

      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      
      req.on('end', () => {
        try {
          const message = JSON.parse(body);
          
          // Ack immediately for typical POST handling, SSE responds.
          res.writeHead(202, { 'Content-Type': 'text/plain' });
          res.end('Accepted');

          handleMcpMessage(message, session, indexingService);
        } catch (err) {
          logger.error('Failed to parse incoming MCP message', err, {}, 'MCP');
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Invalid JSON');
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found. Use /mcp/sse for MCP protocol.' }));
  });

  server.listen(PORT, HOST, () => {
    const sessionInfo = logger.getSessionInfo();
    logger.info(`nIndexer MCP service starting`, { host: HOST, port: PORT }, 'Server');
    logger.info(`SSE endpoint: http://localhost:${PORT}/mcp/sse`, {}, 'Server');
  });

  // Keepalive ping for SSE proxies
  const keepalive = setInterval(() => {
    for (const [, session] of sessions) {
      try {
        session.res.write(':\n\n');
      } catch (err) {
        logger.error('Failed to send keepalive', err, {}, 'Server');
      }
    }
  }, 15000);

  async function gracefulShutdown() {
    logger.warn('Server shutting down', {}, 'Server');
    clearInterval(keepalive);
    server.close();
    for (const [, session] of sessions) session.res.end();
    sessions.clear();
    discoveryService?.stop();
    await shutdownIndexingService?.();
    llmClient?.close();
    logger.close('Server shutdown complete');
    process.exit(0);
  }

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
}

main().catch((err) => {
  logger.error('Fatal server error', err, {}, 'Server');
  logger.close('Fatal error during startup');
  process.exit(1);
});