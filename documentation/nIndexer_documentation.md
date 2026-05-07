# nIndexer Documentation

## Overview

An MCP-native microservice for vector-based semantic search, keyword indexing, and file analysis of codebases. Built with native Node.js (no external dependencies).

## Quick Start

```bash
# Start the HTTP/SSE server
node src/server.js

# Server runs at:
# - HTTP: http://localhost:3666 (health check)
# - SSE: http://localhost:3666/mcp/sse (MCP protocol endpoint)

# Or start the MCP stdio transport (for IDEs like Cursor/Claude Desktop)
node src/mcp-stdio.js
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│             MCP Client (Cursor / Claude Desktop / UI)       │
└─────────────────────────────┬───────────────────────────────┘
  HTTP/SSE (JSON-RPC)         │        Stdio (stdin/stdout)
  ▼                           ▼                           ▼
┌─────────────────────────────────────────────────────────────┐
│               nIndexer (MCP Server Endpoint)                │
│                                                             │
│  HTTP Server ───► Health Check (/health)                   │
│  SSE Endpoint ───► MCP Router (src/api/mcp-router.js)      │
│  Stdio Service ──► MCP Proxy  (src/mcp-stdio.js)           │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              CodebaseIndexingService                        │
│                  (src/services/)                            │
│                                                             │
│  Discovery ───► Auto-discovers projects from root folders  │
│  Indexer ─────► nVDB (Rust vector DB)                      │
│  Metadata ────► SimpleMetadataStore (JSON)                 │
│  Grep ────────► ripgrep process                            │
│  LLM ─────────► Local Embedded LLaMA (Embeddings)          │
└─────────────────────────────────────────────────────────────┘
```

---

## Auto-Discovery

nIndexer automatically discovers and indexes projects from configured root directories. No manual codebase registration needed.

### How it works

1. Scans immediate child folders of each configured root directory
2. Converts folder names to snake_case identifiers (e.g. `MyProject` → `my_project`)
3. Deduplicates by folder name — if the same project exists in multiple roots, the one with the most recent mtime wins
4. Indexes all discovered folders that contain indexable files
5. Folders with zero indexable files are removed from the index
6. Re-scans periodically (configurable interval) and on each maintenance cycle

### Configuration

```json
{
  "discovery": {
    "roots": [
      "C:\\Projects\\",
      "\\\\SERVER\\Share\\Code\\"
    ],
    "scanIntervalMs": 3600000
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `roots` | string[] | Root directories to scan for projects |
| `scanIntervalMs` | number | Re-scan interval in ms (default: 3600000 = 1 hour) |

---

## MCP Protocol

nIndexer implements the Model Context Protocol (MCP) over two transports:

### 1. HTTP/SSE Transport

For remote MCP clients and web-based assistants:

```
GET http://localhost:3666/mcp/sse       # Establish SSE session
POST http://localhost:3666/mcp/message  # Send JSON-RPC requests
```

The SSE endpoint returns an `endpoint` event with the session-specific message URL.

### 2. Standard I/O (stdio) Transport

For local MCP environments like Cursor or Claude Desktop:

```bash
node src/mcp-stdio.js
```

Reads JSON-RPC messages line-by-line from `stdin`, outputs responses to `stdout`. All internal logs are rerouted to `stderr` to prevent JSON-RPC corruption.

---

**Request (Both transports):**
```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "method": "tools/call",
  "params": {
    "name": "search_codebase",
    "arguments": {
      "codebase": "my_project",
      "query": "websocket connection handling",
      "limit": 5
    }
  }
}
```

**Response (formatted as MCP tool result):**
```json
{
  "jsonrpc": "2.0",
  "id": "unique-id",
  "result": {
    "content": [{ "type": "text", "text": "..." }]
  }
}
```

**Error Response:**
```json
{
  "jsonrpc": "2.0",
  "id": "unique-id",
  "error": {
    "code": -32000,
    "message": "Error description"
  }
}
```

---

## Tools Reference

### Indexing

#### `index_codebase`
Index a new codebase for semantic search.

```json
{
  "name": "my-project",
  "source": "//server/share/path/to/project"
}
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Codebase identifier |
| `source` | string | Yes | UNC path or absolute local path |
| `folderName` | string | No | Original folder name (set automatically by discovery) |

**Response:**
```json
{
  "name": "my-project",
  "source": "//server/share/path/to/project",
  "indexed": 125,
  "errors": 0,
  "duration": 10135,
  "rate": 12.33
}
```

> **Note:** Manual indexing is still available but typically unnecessary — discovery handles this automatically.

---

#### `refresh_codebase`
Incrementally update a codebase's index.

```json
{
  "name": "my-project"
}
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Codebase name |

---

#### `remove_codebase`
Remove a codebase from the index. Moved to `trashDir` by default (can be recovered).

```json
{
  "name": "my-project",
  "permanent": false
}
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Codebase name |
| `permanent` | boolean | No | If `true`, permanently delete. If `false` (default), move to trash |

---

### Search

#### `search_codebase` (hybrid)
Combined semantic + keyword search. **Recommended for most queries.**
It utilizes a TF-IDF term density heuristic on the keyword side, combined with an absolute semantic performance floor ($\ge 0.70$), and intelligently penalizes ranking multipliers for boilerplate (`README.md`, `package.json`, `.license`, etc.).

```json
{
  "codebase": "my-project",
  "query": "authentication middleware",
  "strategy": "hybrid",
  "limit": 10
}
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `codebase` | string | Yes | Codebase name (supports partial match) |
| `query` | string | Yes | Search query |
| `strategy` | string | No | `hybrid` (default), `semantic`, `keyword` |
| `limit` | number | No | Max results (default: 10) |
| `filter` | object | No | `{ "language": "javascript" }` |

**Response:**
```json
{
  "results": [
    {
      "file": "my-project:src/auth/middleware.js",
      "path": "src/auth/middleware.js",
      "score": 0.87,
      "semanticScore": 0.9,
      "keywordScore": 0.7,
      "language": "javascript",
      "functions": ["authenticate", "authorize"],
      "classes": []
    }
  ],
  "count": 1,
  "strategy": "hybrid"
}
```

---

#### `search_semantic`
Pure embedding-based semantic search. Best for concept queries.

```json
{
  "codebase": "my-project",
  "query": "how is authentication implemented?",
  "limit": 10
}
```

---

#### `search_keyword`
Fast indexed keyword search. Best for exact matches on names.

```json
{
  "codebase": "my-project",
  "query": "authenticateUser",
  "limit": 20,
  "searchContent": true
}
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `searchContent` | boolean | No | Search file content (default: true) |

---

#### `grep_codebase`
Live regex search using ripgrep. Always current (reads filesystem).

```json
{
  "codebase": "my-project",
  "pattern": "function.*auth",
  "regex": true,
  "limit": 50,
  "maxMatchesPerFile": 5
}
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `pattern` | string | Yes | Search pattern |
| `regex` | boolean | No | Use regex (default: true) |
| `caseSensitive` | boolean | No | Case sensitive (default: false) |
| `pathPattern` | string | No | Filter by path glob |
| `maxMatchesPerFile` | number | No | Max matches per file (default: 5) |

---

#### `search_all_codebases`
Search across all indexed codebases at once.

```json
{
  "query": "websocket handler",
  "strategy": "hybrid",
  "limit": 20,
  "perCodebaseLimit": 5
}
```

---

### File Operations

#### `get_file`
Read file content with staleness check.

```json
{
  "codebase": "my-project",
  "path": "src/main.js"
}
```

**Response:**
```json
{
  "content": "// file content...",
  "stale": false,
  "lastIndexed": "2026-03-27T10:00:00.000Z"
}
```

---

#### `get_file_info`
Get file structure (functions, classes, imports).

```json
{
  "codebase": "my-project",
  "path": "src/main.js"
}
```

**Response:**
```json
{
  "file": "my-project:src/main.js",
  "path": "src/main.js",
  "mtime": "2026-03-26T15:30:00.000Z",
  "size": 1523,
  "language": "javascript",
  "functions": ["main", "init"],
  "classes": ["App"],
  "imports": ["fs", "path"]
}
```

---

#### `get_file_tree`
List files in a directory.

```json
{
  "codebase": "my-project",
  "path": "src"
}
```

---

### Analysis

#### `analyze_codebase`
Run heuristic analysis to generate project description. No LLM required.

```json
{
  "name": "my-project"
}
```

**Response:**
```json
{
  "name": "my-project",
  "analyzed": true,
  "description": "A stateless API gateway...",
  "duration": 28951,
  "filesAnalyzed": 25
}
```

---

#### `get_codebase_description`
Get project description with staleness check.

```json
{
  "name": "my-project"
}
```

**Response:**
```json
{
  "name": "my-project",
  "hasAnalysis": true,
  "stale": false,
  "description": "A stateless API gateway...",
  "purpose": "Routes requests to provider-specific adapters...",
  "insights": {
    "architecture": "modular",
    "techStack": ["nodejs", "express"],
    "keyConcepts": ["API gateway", "adapter pattern"],
    "coreModules": ["model-routing", "adapter-registry"]
  },
  "keyFiles": {
    "high": ["README.md", "src/main.js"],
    "medium": ["src/config.js"],
    "low": ["tests/*.test.js"]
  },
  "entryPoints": ["src/main.js", "src/server.js"],
  "analyzedAt": "2026-03-27T17:14:11.755Z"
}
```

---

#### `get_prioritized_files`
Get files ordered by importance.

```json
{
  "name": "my-project"
}
```

---

### Maintenance

#### `check_codebase_status`
Check staleness status of a codebase.

```json
{
  "codebase": "my-project"
}
```

**Response:**
```json
{
  "codebase": "my-project",
  "totalFiles": 125,
  "staleFiles": 3,
  "missingFiles": 0,
  "lastIndexed": "2026-03-27T10:00:00.000Z"
}
```

---

#### `run_maintenance`
Run maintenance cycle. Discovery re-scans roots before maintenance runs.

```json
{
  "codebase": "my-project",
  "reindex": "if_missing"
}
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `codebase` | string | No | Specific codebase to maintain (omit for all) |
| `reindex` | string | No | Reindex mode: `"if_missing"`, `"changed"`, `"always"`, `null` |

**Reindex Modes:**
- `null` (default) - Check for changes only
- `"if_missing"` - Build index if it doesn't exist
- `"changed"` - Update only changed files
- `"always"` - Force rebuild of existing index

---

#### `get_maintenance_stats`
Get maintenance statistics.

```json
{}
```

---

### Utility

#### `ping`
Health check ping.

```json
{}
```

**Response:**
```json
{ "pong": true, "timestamp": 1774630226437 }
```

---

#### `list_codebases`
List all indexed codebases.

```json
{}
```

**Response:**
```json
[
  {
    "name": "my_project",
    "folderName": "MyProject",
    "source": "\\\\server\\share\\MyProject",
    "files": 125,
    "lastIndexed": "2026-03-27T17:04:35.738Z",
    "status": "current",
    "description": "A stateless API gateway...",
    "hasAnalysis": true,
    "analysisStale": false
  }
]
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Snake_case identifier |
| `folderName` | string | Original folder name |
| `source` | string | Absolute source path |
| `files` | number | Total indexed files |
| `lastIndexed` | string | Last index timestamp |
| `status` | string | `current`, `partial`, `indexing`, `unknown` |
| `description` | string | Project description (if analyzed) |
| `hasAnalysis` | boolean | Whether analysis has been run |
| `analysisStale` | boolean | Whether analysis is outdated |

---

## Configuration

### `config.json`

Service configuration. Paths can be relative (resolved from project root) or absolute.

```json
{
  "service": {
    "host": "localhost",
    "port": 3666,
    "cors": false
  },
  "storage": {
    "dataDir": "./data/codebases",
    "trashDir": "./data/trash"
  },
  "logs": {
    "dir": "./logs",
    "retentionDays": 7
  },
  "indexing": {
    "embeddingDimension": 768,
    "maxFileSize": 1048576,
    "ignorePatterns": [
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "**/build/**",
      "**/bin/**",
      "**/.vscode/**",
      "**/coverage/**"
    ],
    "batchSize": 25,
    "indexBatchSize": 50
  },
  "maintenance": {
    "enabled": true,
    "intervalMs": 900000,
    "autoRefresh": true
  },
  "discovery": {
    "roots": [
      "C:\\Projects\\",
      "\\\\SERVER\\Share\\Code\\"
    ],
    "scanIntervalMs": 3600000
  },
  "llama": {
    "port": 42718,
    "modelPath": "bin/llama/models/jina-embeddings-v2-base-code-Q5_K_M.gguf",
    "ctxSize": 8192,
    "concurrencyLimit": 50
  },
  "llm": {
    "provider": "local",
    "maxConcurrentRequests": 100
  }
}
```

### Configuration Fields

| Section | Field | Type | Description |
|---------|-------|------|-------------|
| `service` | `host` | string | Bind host (default: `localhost`) |
| `service` | `port` | number | Bind port (default: `3666`) |
| `service` | `cors` | boolean | Enable CORS (default: `false`) |
| `storage` | `dataDir` | string | Path for indexed codebase data (relative or absolute) |
| `storage` | `trashDir` | string | Path for removed codebases (relative or absolute) |
| `logs` | `dir` | string | Path for log files (relative or absolute) |
| `logs` | `retentionDays` | number | Days to keep session logs (default: `7`) |
| `indexing` | `embeddingDimension` | number | Embedding vector dimension (default: `768`) |
| `indexing` | `maxFileSize` | number | Max file size in bytes (default: `1048576`) |
| `indexing` | `ignorePatterns` | string[] | Glob patterns to exclude |
| `indexing` | `batchSize` | number | Embedding batch size (default: `25`) |
| `indexing` | `indexBatchSize` | number | DB insert batch size (default: `50`) |
| `maintenance` | `enabled` | boolean | Enable periodic maintenance (default: `true`) |
| `maintenance` | `intervalMs` | number | Maintenance interval in ms (default: `900000`) |
| `maintenance` | `autoRefresh` | boolean | Auto-refresh stale codebases (default: `true`) |
| `discovery` | `roots` | string[] | Root directories to scan for projects |
| `discovery` | `scanIntervalMs` | number | Discovery re-scan interval in ms (default: `3600000`) |
| `llama` | `port` | number | Embedded local LLaMA HTTP port |
| `llama` | `modelPath` | string | Path to GGUF model for local embeddings |
| `llama` | `concurrencyLimit` | number | Semaphore size for concurrent llama-server requests |
| `llm` | `provider` | string | `local` (built-in) or `remote` |
| `llm` | `maxConcurrentRequests` | number | Global max concurrent LLM operations |

---

## Embedding Concurrency Limits

The system uses `Promise.all` alongside a semaphore pattern (`llm.maxConcurrentRequests` / `llama.concurrencyLimit`) to process embeddings without crashing local hardware or remote services.
- Internal limits prevent `llama-server` from crashing locally when fed hundreds of file chunks at once.

---

## Example Client (JavaScript)

```javascript
const ws = new WebSocket('ws://localhost:3666');

ws.onopen = () => {
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: '1',
    method: 'search',
    params: {
      codebase: 'my_project',
      query: 'websocket connection handling',
      limit: 5
    }
  }));
};

ws.onmessage = (e) => {
  const response = JSON.parse(e.data);
  if (response.result) {
    console.log('Results:', response.result);
  } else if (response.error) {
    console.error('Error:', response.error);
  }
};
```

---

## HTTP Endpoints

### `GET /health`

Health check endpoint.

```bash
curl http://localhost:3666/health
```

**Response:**
```json
{
  "status": "ok",
  "service": "nIndexer-MCP"
}
```

---

## Error Codes

| Code | Meaning |
|------|---------|
| `-32600` | Invalid Request |
| `-32601` | Method not found |
| `-32602` | Invalid params |
| `-32603` | Internal error |
| `-32700` | Parse error |
| `-32000` | Service error (with message) |

---

## Dependencies

**None.** Uses only Node.js built-in modules:
- `http` - HTTP server
- `crypto` - UUID generation
- `fs` - File system access
- `path` - Path manipulation
- `fetch` - Native fetch (Node.js 21+)

### External Services Required

1. **LLaMA Server** (port 42718) - Local embedding generation
2. **nVDB** - Rust vector database (compiled binary included)

---

## Project Structure

```
nIndexer/
├── src/
│   ├── server.js                          # HTTP/SSE server
│   ├── mcp-stdio.js                       # Stdio entrypoint for MCP clients
│   ├── api/
│   │   ├── mcp-router.js                  # JSON-RPC message routing
│   │   └── mcp-tools.js                   # MCP tool definitions
│   ├── services/
│   │   ├── indexing.service.js            # Main service
│   │   ├── indexer.service.js             # File walking, embedding
│   │   ├── discovery.service.js           # Auto-discovery from root folders
│   │   ├── maintenance.service.js         # Periodic maintenance
│   │   ├── search-router.service.js       # Hybrid search
│   │   ├── grep.service.js                # ripgrep integration
│   │   ├── metadata.service.js            # JSON metadata store
│   │   └── project-analyzer.service.js    # Heuristic codebase analysis
│   ├── llm-client.js                      # LLaMA embedding client (with circuit breaker)
│   ├── config.js                          # Config loader
│   └── utils/
│       ├── logger.js                      # nLogger wrapper
│       └── llama-spawner.js               # Local LLaMA process management
├── nVDB/                                  # Rust vector DB (submodule)
├── nLogger/                               # Logging utility (submodule)
├── data/
│   ├── codebases/                         # Indexed data (per-codebase subdirs)
│   └── trash/                             # Removed codebases
├── logs/                                  # Session + rolling main logs
├── config.json                            # Service configuration
└── documentation/
    └── nIndexer_documentation.md          # This file
```
