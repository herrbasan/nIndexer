/**
 * Native MCP Router (Model Context Protocol) 
 * Handles JSON-RPC 2.0 messages over HTTP/SSE
 * Zero Dependencies implementation
 */

import { getLogger } from '../utils/logger.js';

const logger = getLogger();
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = {
  name: 'nIndexer-MCP',
  version: '2.0.0',
};

// Map MCP tool names to indexingService methods
const METHOD_MAP = {
  'list_codebases': 'listCodebases',
  'list_spaces': 'listSpaces',
  'index_codebase': 'indexCodebase',
  'refresh_codebase': 'refreshCodebase',
  'remove_codebase': 'removeCodebase',
  'search_codebase': 'search',
  'search_semantic': 'searchSemantic',
  'search_keyword': 'searchKeyword',
  'grep_codebase': 'grepCodebase',
  'search_all_codebases': 'searchAll',
  'get_file_tree': 'getFileTree',
  'get_file_info': 'getFileInfo',
  'get_file': 'getFile',
  'check_codebase_status': 'checkCodebaseStatus',
  'check_file_stale': 'checkFileStale',
  'run_maintenance': 'runMaintenance',
  'get_maintenance_stats': 'getMaintenanceStats',
  'analyze_codebase': 'analyzeCodebase',
  'get_codebase_description': 'getCodebaseDescription',
  'get_prioritized_files': 'getPrioritizedFiles'
};

function jsonrpcResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonrpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export async function handleMcpMessage(message, session, indexingService) {
  if (!message.jsonrpc || message.jsonrpc !== '2.0') {
      session.send({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' } });
      return;
  }

  // Notifications (no id) - just acknowledge implicitly
  if (message.id === undefined || message.id === null) {
      if (message.method !== 'notifications/initialized') {
         logger.debug(`Received unhandled notification: ${message.method}`);
      }
      return;
  }

  const msgId = message.id;

  try {
      switch (message.method) {
          case 'initialize':
              session.send(jsonrpcResponse(msgId, {
                  protocolVersion: PROTOCOL_VERSION,
                  capabilities: { tools: { listChanged: false } },
                  serverInfo: SERVER_INFO,
              }));
              break;

          case 'ping':
              session.send(jsonrpcResponse(msgId, {}));
              break;

          case 'tools/list':
              session.send(jsonrpcResponse(msgId, { tools: indexingService.getTools() }));
              break;

          case 'tools/call': {
              const { name, arguments: args } = message.params || {};
              
              if (!name) {
                  session.send(jsonrpcError(msgId, -32602, 'Invalid params: tool name required'));
                  return;
              }

              const serviceMethod = METHOD_MAP[name];
              if (!serviceMethod) {
                  session.send(jsonrpcError(msgId, -32601, `Tool not found: ${name}`));
                  return;
              }

              if (typeof indexingService[serviceMethod] !== 'function') {
                  session.send(jsonrpcError(msgId, -32601, `Internal service method missing: ${serviceMethod}`));
                  return;
              }

              // Handle progress token (MCP 2025-03-26 spec)
              const progressToken = message.params?._meta?.progressToken;
              const onProgress = (progressData) => {
                  try {
                      if (!progressToken) return;
                      session.send({
                          jsonrpc: '2.0',
                          method: 'notifications/progress',
                          params: {
                              progressToken,
                              progress: progressData.progress || 0,
                              total: progressData.total || 0,
                              message: progressData.message || (progressData.name ? `Indexing ${progressData.name}` : undefined)
                          }
                      });
                  } catch(e) {
                      logger.error("Failed to send progress", e, {}, "Router");
                  }
              };

              // Execute tool
              let rawResult;
              if (['indexCodebase', 'refreshCodebase', 'runMaintenance'].includes(serviceMethod)) {
                  rawResult = await indexingService[serviceMethod](args, onProgress);
              } else {
                  rawResult = await indexingService[serviceMethod](args);
              }

              // MCP tools must return formatted content array [{ type: 'text', text: '...' }]
              const formattedResult = {
                  content: [{
                      type: "text",
                      text: typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult, null, 2)
                  }]
              };

              session.send(jsonrpcResponse(msgId, formattedResult));
              break;
          }

          default:
              session.send(jsonrpcError(msgId, -32601, `Method not found: ${message.method}`));
      }
  } catch (err) {
      if (message.method === 'tools/call' && err.message && err.message.includes("Codebase '") && err.message.includes("' not found")) { const cbName = (err.message.match(/Codebase '([^']+)' not found/) || [])[1] || "target codebase"; logger.info("JIT Indexing triggered", { cbName }, "MCPRouter"); session.send({ jsonrpc: "2.0", id: msgId, result: { isError: true, content: [{ type: "text", text: "The codebase '" + cbName + "' is not currently indexed. Please use the 'index_codebase' tool to index it first, and then run your command again."}] }}); return; } console.error(err);
      logger.error(`Error invoking MCP method ${message.method}`, err, { method: message.method, error: err, trace: err.stack }, 'MCPRouter');
      session.send(jsonrpcError(msgId, -32000, err.message || 'Internal error'));
  }
}
