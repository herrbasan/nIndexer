# nIndexer Documentation

## Overview

A WebSocket-first microservice for vector-based semantic search, keyword indexing, and file analysis of codebases. Built with native Node.js (no external dependencies).

---

## Quick Start

```bash
# Start the server (from any directory)
node src/server.js

# Server runs at:
# - HTTP: http://localhost:3666 (health check only)
# - WebSocket: ws://localhost:3666
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Client (MCP Orchestrator)               │
└─────────────────────────────┬───────────────────────────────┘
                              │ WebSocket / JSON-RPC
                              ▼
┌─────────────────────────────────────────────────────────────┐
│               nIndexer WebSocket Server                     │
│                     (src/server.js)                         │
│                                                             │
│  HTTP Server ───► Health Check (/health)                   │
│  WebSocket ──────► JSON-RPC Router (src/api/router.js)     │
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
│  LLM ─────────► LLM Gateway (HTTP/WS)                      │
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
      "\\\\coolkid\\Work\\Work\\_GIT\\",
      "\\\\BADKID\\Stuff\\DEV\\"
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

## WebSocket API

### Connection

```
ws://localhost:3666
```

### Protocol

JSON-RPC 2.0 over WebSocket.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": "unique-id",
  "method": "tool_name",
  "params": { ... }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": "unique-id",
  "result": { ... }
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

#### `search` (hybrid)
Combined semantic + keyword search. **Recommended for most queries.**

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

Service configuration. All paths should be absolute.

```json
{
  "service": {
    "host": "localhost",
    "port": 3666,
    "cors": false
  },
  "storage": {
    "dataDir": "D:\\DEV\\nIndexer\\data\\codebases",
    "trashDir": "D:\\DEV\\nIndexer\\data\\trash"
  },
  "logs": {
    "dir": "D:\\DEV\\nIndexer\\logs",
    "retentionDays": 7
  },
  "indexing": {
    "embeddingDimension": 3072,
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
      "\\\\coolkid\\Work\\Work\\_GIT\\",
      "\\\\BADKID\\Stuff\\DEV\\"
    ],
    "scanIntervalMs": 3600000
  },
  "llm": {
    "gatewayWsUrl": "ws://localhost:3400/v1/realtime",
    "gatewayHttpUrl": "http://localhost:3400"
  }
}
```

### Configuration Fields

| Section | Field | Type | Description |
|---------|-------|------|-------------|
| `service` | `host` | string | Bind host (default: `localhost`) |
| `service` | `port` | number | Bind port (default: `3666`) |
| `service` | `cors` | boolean | Enable CORS (default: `false`) |
| `storage` | `dataDir` | string | Absolute path for indexed codebase data |
| `storage` | `trashDir` | string | Absolute path for removed codebases |
| `logs` | `dir` | string | Absolute path for log files |
| `logs` | `retentionDays` | number | Days to keep session logs (default: `7`) |
| `indexing` | `embeddingDimension` | number | Embedding vector dimension (default: `3072`) |
| `indexing` | `maxFileSize` | number | Max file size in bytes (default: `1048576`) |
| `indexing` | `ignorePatterns` | string[] | Glob patterns to exclude |
| `indexing` | `batchSize` | number | Embedding batch size (default: `25`) |
| `indexing` | `indexBatchSize` | number | DB insert batch size (default: `50`) |
| `maintenance` | `enabled` | boolean | Enable periodic maintenance (default: `true`) |
| `maintenance` | `intervalMs` | number | Maintenance interval in ms (default: `900000`) |
| `maintenance` | `autoRefresh` | boolean | Auto-refresh stale codebases (default: `true`) |
| `discovery` | `roots` | string[] | Root directories to scan for projects |
| `discovery` | `scanIntervalMs` | number | Discovery re-scan interval in ms (default: `3600000`) |
| `llm` | `gatewayWsUrl` | string | LLM Gateway WebSocket URL |
| `llm` | `gatewayHttpUrl` | string | LLM Gateway HTTP URL |

---

## Embedding Circuit Breaker

The LLM client includes a circuit breaker that stops indexing when the embedding service is unavailable:

- After 3 consecutive embedding failures, the circuit breaker trips for 60 seconds
- Pending indexing batches are gracefully stopped (already-embedded files are still stored)
- Discovery defers indexing new codebases until the circuit resets
- The circuit auto-resets after the cooldown period

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
  "service": "nIndexer",
  "version": "1.0.0",
  "timestamp": "2026-03-27T17:00:00.000Z"
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
- `crypto` - WebSocket handshake
- `fs` - File system access
- `path` - Path manipulation
- `WebSocket` - Native WebSocket (Node.js 21+)
- `fetch` - Native fetch (Node.js 21+)

### External Services Required

1. **LLM Gateway** (port 3400) - For embeddings and analysis
2. **nVDB** - Rust vector database (compiled binary included)

---

## Project Structure

```
nIndexer/
├── src/
│   ├── server.js                          # WebSocket/HTTP server
│   ├── api/
│   │   └── router.js                      # JSON-RPC message routing
│   ├── services/
│   │   ├── indexing.service.js            # Main service
│   │   ├── indexer.service.js             # File walking, embedding
│   │   ├── discovery.service.js           # Auto-discovery from root folders
│   │   ├── maintenance.service.js         # Periodic maintenance
│   │   ├── search-router.service.js       # Hybrid search
│   │   ├── grep.service.js                # ripgrep integration
│   │   ├── metadata.service.js            # JSON metadata store
│   │   └── project-analyzer.service.js    # Heuristic codebase analysis
│   ├── llm-client.js                      # LLM Gateway client (with circuit breaker)
│   └── config.js                          # Config loader
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
