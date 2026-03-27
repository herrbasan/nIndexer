/**
 * WebSocket Router
 *
 * Handles:
 * - JSON-RPC 2.0 message routing
 * - Client connection management
 * - Event subscriptions
 * - Tool method to service method mapping
 */

import { randomUUID } from 'crypto';

const JSONRPC_VERSION = '2.0';

// Tool method name to service method mapping
const METHOD_MAP = {
  'list_codebases': 'listCodebases',
  'list_spaces': 'listSpaces',
  'index_codebase': 'indexCodebase',
  'refresh_codebase': 'refreshCodebase',
  'remove_codebase': 'removeCodebase',
  'search': 'search',
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

// Methods that support progress events (via subscribe)
const PROGRESSABLE_METHODS = new Set([
  'index_codebase',
  'refresh_codebase',
  'analyze_codebase',
  'run_maintenance'
]);

export function createRouter(indexingService) {
  const clients = new Map(); // clientId → { ws, subscriptions: Set<subscriptionId> }
  const subscriptions = new Map(); // subscriptionId → { clientId, event, filter? }
  const pendingRequests = new Map(); // temp storage during async operations

  /**
   * Add a new client connection
   */
  function addClient(ws) {
    const clientId = randomUUID();
    clients.set(clientId, { ws, subscriptions: new Set() });
    return clientId;
  }

  /**
   * Remove a client and clean up subscriptions
   */
  function removeClient(clientId) {
    const client = clients.get(clientId);
    if (client) {
      // Remove all subscriptions for this client
      for (const subId of client.subscriptions) {
        subscriptions.delete(subId);
      }
      clients.delete(clientId);
    }
  }

  /**
   * Close all client connections
   */
  function closeAll() {
    for (const [clientId, client] of clients) {
      client.ws.close();
    }
    clients.clear();
    subscriptions.clear();
  }

  /**
   * Send a message to a specific client
   */
  function sendToClient(clientId, message) {
    const client = clients.get(clientId);
    if (client && client.ws.readyState === 1) { // WebSocket.OPEN
      client.ws.send(JSON.stringify(message));
    }
  }

  /**
   * Broadcast an event to all subscribed clients
   */
  function broadcastEvent(eventName, data, filter = null) {
    for (const [subId, sub] of subscriptions) {
      if (sub.event !== eventName) continue;
      if (filter && sub.filter && !filterMatches(sub.filter, data)) continue;
      sendToClient(sub.clientId, {
        jsonrpc: JSONRPC_VERSION,
        method: 'event',
        params: { event: eventName, data }
      });
    }
  }

  /**
   * Check if a filter object matches event data
   */
  function filterMatches(filter, data) {
    if (!filter) return true;
    for (const [key, value] of Object.entries(filter)) {
      if (data[key] !== value) return false;
    }
    return true;
  }

  /**
   * Handle an incoming message from a client
   */
  function handleMessage(clientId, message) {
    // Validate JSON-RPC structure
    if (!message.jsonrpc || message.jsonrpc !== JSONRPC_VERSION) {
      sendToClient(clientId, {
        jsonrpc: JSONRPC_VERSION,
        error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' }
      });
      return;
    }

    if (message.method === 'subscribe') {
      handleSubscribe(clientId, message);
      return;
    }

    if (message.method === 'unsubscribe') {
      handleUnsubscribe(clientId, message);
      return;
    }

    if (message.method === 'ping') {
      sendToClient(clientId, {
        jsonrpc: JSONRPC_VERSION,
        id: message.id,
        result: { pong: true, timestamp: Date.now() }
      });
      return;
    }

    // Handle tool invocation
    handleInvoke(clientId, message);
  }

  /**
   * Handle subscribe request
   */
  function handleSubscribe(clientId, message) {
    const { event, filter } = message.params || {};
    if (!event) {
      sendToClient(clientId, {
        jsonrpc: JSONRPC_VERSION,
        id: message.id,
        error: { code: -32602, message: 'Invalid Params: event is required' }
      });
      return;
    }

    const subscriptionId = randomUUID();
    subscriptions.set(subscriptionId, { clientId, event, filter });

    const client = clients.get(clientId);
    if (client) {
      client.subscriptions.add(subscriptionId);
    }

    sendToClient(clientId, {
      jsonrpc: JSONRPC_VERSION,
      id: message.id,
      result: { subscribed: true, subscriptionId }
    });
  }

  /**
   * Handle unsubscribe request
   */
  function handleUnsubscribe(clientId, message) {
    const { subscriptionId } = message.params || {};
    const sub = subscriptions.get(subscriptionId);

    if (!sub || sub.clientId !== clientId) {
      sendToClient(clientId, {
        jsonrpc: JSONRPC_VERSION,
        id: message.id,
        error: { code: -32602, message: 'Invalid Params: subscription not found' }
      });
      return;
    }

    subscriptions.delete(subscriptionId);
    const client = clients.get(clientId);
    if (client) {
      client.subscriptions.delete(subscriptionId);
    }

    sendToClient(clientId, {
      jsonrpc: JSONRPC_VERSION,
      id: message.id,
      result: { unsubscribed: true }
    });
  }

  /**
   * Handle tool/method invocation
   */
  async function handleInvoke(clientId, message) {
    const { id, method, params = {} } = message;
    const serviceMethod = METHOD_MAP[method];

    if (!serviceMethod) {
      sendToClient(clientId, {
        jsonrpc: JSONRPC_VERSION,
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
      });
      return;
    }

    const service = indexingService;
    if (typeof service[serviceMethod] !== 'function') {
      sendToClient(clientId, {
        jsonrpc: JSONRPC_VERSION,
        id,
        error: { code: -32601, message: `Service method not found: ${serviceMethod}` }
      });
      return;
    }

    // Create progress callback for progressable methods
    const onProgress = PROGRESSABLE_METHODS.has(method)
      ? (progressData) => {
          broadcastEvent('index.progress', {
            method,
            ...progressData
          }, { codebase: params.name || params.codebase });
        }
      : null;

    // Execute the service method
    try {
      // Bind the progress callback as the second argument for methods that need it
      let result;
      if (onProgress && ['indexCodebase', 'refreshCodebase', 'analyzeCodebase', 'runMaintenance'].includes(serviceMethod)) {
        result = await service[serviceMethod](params, onProgress);
      } else {
        result = await service[serviceMethod](params);
      }

      sendToClient(clientId, {
        jsonrpc: JSONRPC_VERSION,
        id,
        result
      });
    } catch (err) {
      console.error(`[Router] Error invoking ${method}:`, err);
      sendToClient(clientId, {
        jsonrpc: JSONRPC_VERSION,
        id,
        error: {
          code: -32000,
          message: err.message || 'Internal error',
          data: err.stack?.split('\n')[1]?.trim() // First line of stack trace
        }
      });
    }
  }

  return {
    addClient,
    removeClient,
    closeAll,
    handleMessage,
    broadcastEvent
  };
}