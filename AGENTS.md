# nIndexer — Agent Guidelines

## Project Overview

nIndexer is a **semantic code search engine** that provides intelligent codebase indexing and search capabilities via WebSocket API. It powers MCP (Model Context Protocol) tools for AI assistants to search, analyze, and understand codebases.

### Core Features

- **Semantic Search** — Vector-based similarity search using embeddings (768-dim)
- **Keyword Search** — Path + content search with ripgrep integration using TF-IDF term density heuristics
- **Hybrid Search** — Combines semantic + keyword with absolute semantic protection floor (>= 0.70) and boilerplate noise penalization
- **Codebase Analysis** — Heuristic-based project understanding and file prioritization
- **Multi-codebase Support** — Index and search across multiple projects simultaneously

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      nIndexer Server                         │
│  (src/server.js - WebSocket + HTTP on port 3666)            │
├─────────────────────────────────────────────────────────────┤
│  API Router (src/api/router.js)                             │
│  - JSON-RPC 2.0 message handling                            │
│  - Client connection management                             │
│  - Event subscriptions                                      │
├─────────────────────────────────────────────────────────────┤
│  Indexing Service (src/services/indexing.service.js)        │
│  - Codebase management (index, refresh, remove)             │
│  - Search orchestration (semantic, keyword, hybrid, grep)   │
│  - Maintenance automation                                   │
├─────────────────────────────────────────────────────────────┤
│  Indexer (src/services/indexer.service.js)                  │
│  - File walking and parsing                                 │
│  - Batch embedding generation                               │
│  - nVDB vector insertion                                    │
├─────────────────────────────────────────────────────────────┤
│  nVDB (nVDB/) — Native Rust vector database                 │
│  - HNSW approximate nearest neighbor search                 │
│  - In-memory storage with WAL persistence                   │
│  - Node.js bindings via napi-rs                             │
└─────────────────────────────────────────────────────────────┘
```

### Key Components

| Component | Location | Purpose |
|-----------|----------|---------|
| **Server** | `src/server.js` | WebSocket HTTP server, client management |
| **Router** | `src/api/router.js` | JSON-RPC message routing, subscriptions |
| **Indexing Service** | `src/services/indexing.service.js` | Codebase CRUD, search orchestration |
| **Indexer** | `src/services/indexer.service.js` | File parsing, embedding generation |
| **Metadata Store** | `src/services/metadata.service.js` | File manifest (paths, hashes, languages) |
| **Grep Service** | `src/services/grep.service.js` | ripgrep integration for content search |
| **Search Router** | `src/services/search-router.service.js` | Result ranking and combination |
| **Maintenance** | `src/services/maintenance.service.js` | Stale file cleanup, auto-refresh |
| **Project Analyzer** | `src/services/project-analyzer.service.js` | Heuristic codebase analysis |
| **nVDB** | `nVDB/` | Rust vector database (submodule) |
| **nLogger** | `nLogger/` | Logging utility (submodule) |

## Development Guidelines

### Code Style

- **No comments** unless explicitly requested
- **Direct and concise** — avoid preamble/postamble
- **ES Modules** — use `import/export`, not CommonJS
- **Async/await** — prefer over raw promises
- **Error handling** — log errors, don't silently swallow

### Testing

```bash
# Start server
node src/server.js

# Development mode (auto-reload)
node --watch src/server.js

# Health check
curl http://localhost:3666/health
```

### MCP Tools Available

| Tool | Description |
|------|-------------|
| `list_codebases` | List all indexed codebases |
| `index_codebase` | Index a new codebase |
| `refresh_codebase` | Refresh an existing codebase |
| `remove_codebase` | Remove a codebase from index |
| `search_codebase` | Hybrid search (semantic + keyword) |
| `search_semantic` | Vector similarity search |
| `search_keyword` | Path + content keyword search |
| `grep_codebase` | Live ripgrep search |
| `search_all_codebases` | Search across all codebases |
| `get_file_tree` | Get directory structure |
| `get_file_info` | Get file metadata and structure |
| `get_file` | Get full file content |
| `check_codebase_status` | Check staleness and file count |
| `check_file_stale` | Check if specific file is stale |
| `get_codebase_description` | Get AI-generated project description |
| `get_prioritized_files` | Get files ordered by importance |
| `analyze_codebase` | Run heuristic analysis |

## Logging System

### nLogger Integration

nIndexer uses **nLogger** (Git submodule at `nLogger/`) for production-ready logging.

#### Log Location

```
D:\DEV\nIndexer\logs\
├── 2026-04-05-03-52-35-nidx-l86z4a.log  # Session log
└── main-0.log                            # Rolling main log
```

**Configuration:** `config.json`
```json
{
  "logs": {
    "dir": "./logs",
    "retentionDays": 7
  }
}
```

#### Logger Pattern

**Import:**
```javascript
import { getLogger } from './utils/logger.js';

const logger = getLogger();
```

**Usage:**
```javascript
// Info level
logger.info('Server started', { port: 3000 }, 'System');

// Warning level
logger.warn('High memory usage', { percent: 85 }, 'Monitoring');

// Error level (includes stack trace)
logger.error('Database query failed', error, { query: 'SELECT...' }, 'Database');

// Debug level (only in DEBUG mode)
logger.debug('Verbose details', { data: '...' }, 'Debug');

// Get session info
const session = logger.getSessionInfo();
// Returns: { sessionId, logFile, startedAt }

// Graceful shutdown
logger.close('Server shutdown complete');
```

**Parameters:**
```javascript
logger.level(message, meta, type)
// message: string - The log message
// meta: object (optional) - Structured metadata (auto-sanitized)
// type: string (optional, default: 'System') - Event category/type
```

#### Log Formats

**Session Log** (human-readable, one file per session):
```
[2026-04-05T03:52:35.123Z] [INFO] [Server] nIndexer service starting {"host":"localhost","port":3666,"sessionId":"nidx-l86z4a"}
[2026-04-05T03:52:36.456Z] [INFO] [WebSocket] Client connected: abc-123 from ::1
[2026-04-05T03:52:37.789Z] [WARN] [CodebaseIndexing] Preload failed {"error":"Network timeout"}
```

**Main Log** (JSON Lines, machine-parseable, rolling):
```json
{"ts":"2026-04-05T03:52:35.123Z","level":"INFO","type":"Server","msg":"nIndexer service starting","meta":{"host":"localhost","port":3666},"session":"nidx-l86z4a"}
{"ts":"2026-04-05T03:52:36.456Z","level":"INFO","type":"WebSocket","msg":"Client connected","meta":{"clientId":"abc-123","remoteAddress":"::1"},"session":"nidx-l86z4a"}
```

#### Querying Logs

```bash
# View all errors
cat logs/main-0.log | jq 'select(.level == "ERROR")'

# Filter by session
cat logs/main-0.log | jq 'select(.session == "nidx-l86z4a")'

# Filter by type
cat logs/main-0.log | jq 'select(.type == "WebSocket")'

# View recent session log
cat logs/2026-04-05-*.log

# Count errors by type
cat logs/main-0.log | jq -r 'select(.level == "ERROR") | .type' | sort | uniq -c
```

#### Auto-Sanitization

The logger automatically sanitizes metadata to prevent log bloat:
- **Long strings** (>500 chars) are truncated with length indicator
- **Base64 data** is replaced with `[BINARY_DATA](N chars)`
- **Binary fields** (`b64_json`, `base64`, `buffer`, `data`) are automatically detected

#### Session Lifecycle

- **Session ID format:** `nidx-XXXXXX` (6-char base36 timestamp)
- **Session log:** Created on startup, closed on shutdown
- **Retention:** Auto-deleted after `logs.retentionDays` (default: 7)
- **Main log:** Rolling by size (10MB), keeps last 10 files

### Best Practices

1. **Always use logger, not console** — Console output is ephemeral
2. **Include structured metadata** — Makes logs queryable
3. **Use appropriate types** — Categorize by component (Server, WebSocket, CodebaseIndexing, etc.)
4. **Log errors with stack traces** — Pass error object as second parameter
5. **Don't log sensitive data** — API keys, tokens, passwords
6. **Use DEBUG level sparingly** — Only enabled with `DEBUG=true` or `NODE_ENV=development`

## Configuration

### config.json Structure

```json
{
  "service": {
    "host": "localhost",
    "port": 3666,
    "cors": false
  },
  "storage": {
    "dataDir": "./data/codebases"
  },
  "logs": {
    "dir": "./logs",
    "retentionDays": 7
  },
  "indexing": {
    "embeddingDimension": 768,
    "maxFileSize": 1048576,
    "ignorePatterns": ["**/node_modules/**", "**/.git/**"],
    "batchSize": 25,
    "indexBatchSize": 50
  },
  "maintenance": {
    "enabled": true,
    "intervalMs": 900000,
    "autoRefresh": true
  },
  "llm": {
    "gatewayWsUrl": "ws://localhost:3400/v1/realtime",
    "gatewayHttpUrl": "http://localhost:3400"
  }
}
```

## Submodules

| Submodule | Location | Purpose |
|-----------|----------|---------|
| **nVDB** | `nVDB/` | Rust vector database with Node.js bindings |
| **nLogger** | `nLogger/` | Zero-dependency logging utility |

### Updating Submodules

```bash
# Update all submodules
git submodule update --remote --merge

# Update specific submodule
cd nVDB && git pull origin main && cd ..
cd nLogger && git pull origin main && cd ..

# Commit updates
git add nVDB nLogger
git commit -m "Update submodules"
```

## Common Tasks

### Adding a New Codebase

```javascript
// Via MCP tool
index_codebase({
  name: "MyProject",
  space: "COOLKID-Work",
  project: "MyProject"
})

// Or with absolute path
index_codebase({
  name: "MyProject",
  source: "D:\\Projects\\MyProject"
})
```

### Searching Code

```javascript
// Hybrid search (recommended)
search_codebase({
  codebase: "MyProject",
  query: "how is authentication implemented",
  strategy: "hybrid",
  limit: 10
})

// Keyword search (exact match)
search_keyword({
  codebase: "MyProject",
  query: "authenticateUser",
  searchContent: true,
  limit: 10
})

// Semantic search (conceptual)
search_semantic({
  codebase: "MyProject",
  query: "user login validation",
  limit: 10
})

// Live grep (regex)
grep_codebase({
  codebase: "MyProject",
  pattern: "function\\s+auth.*\\(",
  regex: true,
  limit: 20
})
```

### Debugging Search Issues

1. **Check if codebase is indexed:**
   ```javascript
   list_codebases()
   ```

2. **Check codebase status:**
   ```javascript
   check_codebase_status({ name: "MyProject" })
   ```

3. **Verify source path is accessible:**
   - Check logs for grep errors
   - Look for "Source path: X, exists: false" in logs

4. **Test with grep directly:**
   ```javascript
   grep_codebase({
     codebase: "MyProject",
     pattern: "searchTerm",
     regex: false,
     limit: 10
   })
   ```

## Troubleshooting

### Port Already in Use

```bash
# Find process using port 3666
netstat -ano | findstr :3666

# Kill process (PowerShell)
Stop-Process -Id <PID> -Force
```

### Logs Not Being Created

1. Check `config.json` has `logs.dir` configured
2. Verify write permissions in logs directory
3. Check for errors in console output

### Search Returns Empty Results

1. Verify codebase is indexed: `list_codebases()`
2. Check if term exists with grep: `grep_codebase(...)`
3. Check logs for grep errors (source path inaccessible)
4. Verify query isn't too short (< 3 chars may not match)

### High Memory Usage

1. Check nVDB in-memory size
2. Reduce `indexing.batchSize` in config
3. Run maintenance: `run_maintenance({ name: "MyProject" })`

## Performance Notes

- **Indexing speed:** ~100-200 files/second (depends on embedding model)
- **Search latency:** <150ms for semantic/hybrid via `search_all`, ~9-20ms locally. Increased semantic `top_k` query by $3\times$ to boost low-ranking conceptual code logic in hybrid strategies.
- **Memory usage:** ~100MB per 10k files (vectors in memory)
- **Disk usage:** ~500KB per file (vectors + metadata)

## Security

- **No authentication** — Bind to localhost only in production
- **No input validation** — Trust MCP client inputs
- **File access** — Only indexes configured directories
- **Log sanitization** — Auto-truncates long strings, hides base64 data
