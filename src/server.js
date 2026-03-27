/**
 * nIndexer WebSocket Server
 *
 * Native Node.js HTTP + WebSocket server (no external dependencies).
 * Implements WebSocket handshake manually using built-in crypto and http modules.
 */

import http from 'http';
import { createHash, randomUUID } from 'crypto';
import { config } from './config.js';
import { LLMClient } from './llm-client.js';
import { init as initIndexingService, shutdown as shutdownIndexingService } from './services/indexing.service.js';
import { createRouter } from './api/router.js';

const HOST = config.service.host;
const PORT = config.service.port;

let server;
let router;
let llmClient;
let indexingService;

// WebSocket opcodes
const WS_OPCODE_TEXT = 0x01;
const WS_OPCODE_TEXT_FRAME = 0x81; // FIN + text opcode for building frames
const WS_OPCODE_CLOSE = 0x08;
const WS_OPCODE_CLOSE_FRAME = 0x88; // FIN + close opcode for building frames

/**
 * Parse WebSocket frame (minimal parser for text frames)
 */
function parseWSFrame(data) {
  const firstByte = data[0];
  const opcode = firstByte & 0x0f;
  const secondByte = data[1];
  const isMasked = (secondByte & 0x80) !== 0;
  let offset = 2;
  let payloadLength = secondByte & 0x7f;

  if (payloadLength === 126) {
    payloadLength = data.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    payloadLength = Number(data.readBigUInt64BE(2));
    offset = 10;
  }

  let maskingKey = null;
  if (isMasked) {
    maskingKey = data.slice(offset, offset + 4);
    offset += 4;
  }

  let payload = data.slice(offset, offset + Number(payloadLength));

  if (isMasked && maskingKey) {
    payload = Buffer.from(payload.map((byte, i) => byte ^ maskingKey[i % 4]));
  }

  return { opcode, payload: payload.toString('utf8') };
}

/**
 * Build WebSocket frame for text message
 */
function buildWSFrame(message) {
  const payload = Buffer.from(message, 'utf8');
  const payloadLength = payload.length;

  let frame;
  if (payloadLength <= 125) {
    frame = Buffer.alloc(2 + payloadLength);
    frame[1] = payloadLength;
  } else if (payloadLength <= 65535) {
    frame = Buffer.alloc(4 + payloadLength);
    frame[1] = 126;
    frame.writeUInt16BE(payloadLength, 2);
  } else {
    frame = Buffer.alloc(10 + payloadLength);
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(payloadLength), 2);
  }

  frame[0] = WS_OPCODE_TEXT_FRAME;
  payload.copy(frame, frame.length - payloadLength);

  return frame;
}

/**
 * Build WebSocket close frame
 */
function buildWSCloseFrame() {
  const frame = Buffer.alloc(2);
  frame[0] = WS_OPCODE_CLOSE_FRAME;
  frame[1] = 0;
  return frame;
}

/**
 * Compute WebSocket accept key from challenge
 */
function computeAcceptKey(key) {
  const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
  return createHash('sha1').update(key + GUID).digest('base64');
}

/**
 * Create a WebSocket wrapper around a net socket
 */
function createWsSocket(socket, router) {
  const clientId = randomUUID();
  let isClosed = false;

  const ws = {
    readyState: 0, // CONNECTING

    send(data) {
      if (isClosed) return;
      const str = typeof data === 'string' ? data : JSON.stringify(data);
      const frame = buildWSFrame(str);
      socket.write(frame);
    },

    close() {
      if (isClosed) return;
      isClosed = true;
      socket.write(buildWSCloseFrame());
      socket.end();
    },

    on(event, handler) {
      if (event === 'message') {
        socket.on('data', (chunk) => {
          try {
            const { opcode, payload } = parseWSFrame(chunk);
            if (opcode === WS_OPCODE_TEXT) {
              const message = JSON.parse(payload);
              handler(message);
            } else if (opcode === WS_OPCODE_CLOSE) {
              // Client initiated close - respond with close frame and close socket
              isClosed = true;
              socket.write(buildWSCloseFrame());
              socket.end();
              handler({ type: 'close' });
            }
          } catch (err) {
            // Ignore parse errors
          }
        });
      } else if (event === 'close') {
        socket.on('close', handler);
      } else if (event === 'error') {
        socket.on('error', handler);
      }
    }
  };

  // Connection established
  ws.readyState = 1; // OPEN

  return ws;
}

async function main() {
  // Initialize LLM client
  llmClient = new LLMClient();

  // Initialize the indexing service
  const serviceConfig = {
    ...config.indexing,
    spaces: config.spaces,
    maintenance: config.maintenance
  };
  indexingService = await initIndexingService({
    config: { codebase: serviceConfig },
    gateway: llmClient
  });

  // Create WebSocket router
  router = createRouter(indexingService);

  // Create HTTP server with WebSocket upgrade handling
  server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        service: 'nIndexer',
        version: '1.0.0',
        timestamp: new Date().toISOString()
      }));
      return;
    }

    // All other routes return 404 for HTTP (WebSocket is primary)
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found. Use WebSocket on this endpoint.' }));
  });

  // Handle WebSocket upgrade
  server.on('upgrade', (req, socket, head) => {
    // Verify it's a WebSocket upgrade request
    const upgrade = req.headers.upgrade?.toLowerCase();
    if (upgrade !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const acceptKey = computeAcceptKey(key);

    // Send upgrade response
    const response = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '',
      ''
    ].join('\r\n');

    socket.write(response);

    // Create WebSocket wrapper
    const ws = createWsSocket(socket, router);
    const clientId = router.addClient(ws);
    console.log(`[Server] Client connected: ${clientId} from ${socket.remoteAddress}`);

    ws.on('message', (message) => {
      try {
        router.handleMessage(clientId, message);
      } catch (err) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32700, message: 'Parse error: Invalid JSON' }
        }));
      }
    });

    ws.on('close', () => {
      router.removeClient(clientId);
      console.log(`[Server] Client disconnected: ${clientId}`);
    });

    ws.on('error', (err) => {
      console.error(`[Server] WebSocket error for ${clientId}:`, err.message);
    });
  });

  // Start listening
  server.listen(PORT, HOST, () => {
    console.log(`[Server] nIndexer service running at http://${HOST}:${PORT}`);
    console.log(`[Server] WebSocket endpoint: ws://${HOST}:${PORT}`);
    console.log(`[Server] Health check: http://${HOST}:${PORT}/health`);
  });

  // Graceful shutdown
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function shutdown() {
  console.log('[Server] Shutting down...');

  // Close all client connections
  router?.closeAll();

  // Shutdown indexing service
  await shutdownIndexingService?.();

  // Close LLM client
  llmClient?.close();

  process.exit(0);
}

main().catch((err) => {
  console.error('[Server] Fatal error:', err);
  process.exit(1);
});