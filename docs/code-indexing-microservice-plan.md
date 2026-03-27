# Code Indexing Microservice Plan

## Overview

Split the code indexing functionality from the `codebase` agent into an independent microservice. The microservice will handle vector-based semantic search, keyword indexing, and file analysis, exposing these capabilities via HTTP API to be consumed by the MCP orchestrator.

---

## 1. Current Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         MCP Orchestrator                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │ browser  │  │ codebase │  │  memory  │  │  research│  ...     │
│  └──────────┘  └────┬─────┘  └──────────┘  └──────────┘          │
│                     │                                               │
│                     ▼                                               │
│         ┌───────────────────────┐                                  │
│         │  CodebaseIndexingService │                                │
│         │  (in src/agents/codebase)│                                │
│         └───────┬────────┬───────┘                                  │
│                 │        │                                           │
│     ┌───────────┼────────┼───────────┐                              │
│     ▼           ▼        ▼           ▼                              │
│  ┌──────┐  ┌────────┐  ┌─────┐  ┌──────────┐                       │
│  │ nVDB │  │SQLite/ │  │LLM  │  │  File    │                       │
│  │(Rust)│  │Metadata│  │Router│  │ System   │                       │
│  └──────┘  └────────┘  └─────┘  └──────────┘                       │
└─────────────────────────────────────────────────────────────────────┘
```

### Components to Extract

| Component | File(s) | Purpose | Extraction |
|-----------|---------|---------|------------|
| **CodebaseIndexingService** | `index.js` | Main orchestrator | Core service |
| **Indexer** | `indexer.js` | File walking, parsing, embedding | Core service |
| **AutoIndexer** | `auto-index.js` | Background indexing | Core service |
| **Maintenance** | `maintenance.js` | Staleness detection, refresh | Core service |
| **SearchRouter** | `search-router.js` | Hybrid semantic + keyword search | Core service |
| **GrepSearcher** | `grep.js` | Live regex search | Core service |
| **SimpleMetadataStore** | `simple-metadata.js` | JSON metadata storage | Core service |
| **ProjectAnalyzer** | `project-analyzer.js` | LLM project analysis | Core service |
| **Parser** | `parser/` | Code parsing (JS/TS, Python, Rust) | Core service |
| **nVDB** | `nVDB/` | Rust vector database (git submodule) | **Kept as embedded** |
| **LLM Router** | `src/router/` | Embedding generation | Remote dependency |
| **Config** | `config.json`, `agents/codebase/config.json` | Settings | Split config |

---

## 2. Target Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         MCP Orchestrator                           │
│                                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │ browser  │  │ codebase │  │  memory  │  │ research │          │
│  └──────────┘  └────┬─────┘  └──────────┘  └──────────┘          │
│                     │ HTTP/JSON                                     │
└─────────────────────┼───────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   Code Indexing Microservice                        │
│                       (New Service)                                 │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    REST/HTTP API Layer                        │  │
│  │  POST /index          POST /search        GET /status/:id    │  │
│  │  POST /search/semantic POST /analyze      GET /codebases     │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                              │                                      │
│  ┌───────────────────────────┼───────────────────────────────┐    │
│  │              CodebaseIndexingService                         │    │
│  │  (moved from src/agents/codebase)                           │    │
│  └───────┬────────┬───────┬────────┬────────┬───────────────┘    │
│          │        │        │        │        │                     │
│  ┌───────▼──┐ ┌───▼────┐ ┌──▼──┐ ┌──▼──┐ ┌──▼──────┐               │
│  │  nVDB    │ │SQLite/ │ │LLM  │ │File │ │Metadata │               │
│  │(embedded)│ │ Index  │ │Client│ │System│ │ Store  │               │
│  └──────────┘ └────────┘ └──┬──┘ └─────┘ └─────────┘               │
│                            │                                       │
│              ┌─────────────┴─────────────┐                         │
│              │    WebSocket (chat)        │                         │
│              │    HTTP (embeddings)        │                         │
│              └─────────────┬─────────────┘                         │
│                            ▼                                       │
│                    ┌──────────────┐                               │
│                    │ LLM Gateway  │                               │
│                    │  (port 3400)  │                               │
│                    └──────────────┘                               │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. API Design

### Base URL
```
http://localhost:3101/api/v1
```

### Endpoints

#### Indexing

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/index` | Index a codebase |
| `POST` | `/index/refresh` | Refresh/re-index existing codebase |
| `DELETE` | `/index/:codebaseId` | Remove a codebase from index |
| `GET` | `/index/:codebaseId/status` | Get indexing status |
| `GET` | `/codebases` | List all indexed codebases |

#### Search

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/search` | Hybrid semantic + keyword search |
| `POST` | `/search/semantic` | Pure embedding-based search |
| `POST` | `/search/keyword` | Fast keyword search |
| `POST` | `/search/grep` | Regex search via ripgrep |

#### Analysis

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/analyze` | Analyze project structure |
| `GET` | `/codebases/:codebaseId/description` | Get LLM summary |
| `GET` | `/codebases/:codebaseId/prioritized-files` | Get important files |

#### File Operations

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/codebases/:codebaseId/files/*path` | Read file contents |
| `GET` | `/codebases/:codebaseId/files` | List files with metadata |

### Request/Response Examples

#### POST /index
```json
// Request
{
  "codebaseId": "my-project",
  "source": "d:\\Work\\Project",
  "name": "My Project",
  "options": {
    "ignorePatterns": ["node_modules", ".git", "dist"],
    "maxFileSize": 1048576
  }
}

// Response
{
  "success": true,
  "codebaseId": "my-project",
  "stats": {
    "indexed": 1523,
    "errors": 2,
    "duration": 45230,
    "rate": 33.67
  }
}
```

#### POST /search
```json
// Request
{
  "codebaseId": "my-project",
  "query": "authentication middleware",
  "limit": 10,
  "strategy": "hybrid"
}

// Response
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
  "strategy": "hybrid",
  "queryEmbedding": [0.123, ...],
  "duration": 45
}
```

---

## 4. Project Structure

```
code-indexing-service/
├── src/
│   ├── server.js              # Express server entry point
│   ├── api/
│   │   ├── routes.js           # Route definitions
│   │   ├── indexing.routes.js  # /index, /refresh, /delete
│   │   ├── search.routes.js    # /search, /search/semantic, etc.
│   │   ├── analysis.routes.js  # /analyze
│   │   └── file.routes.js      # /files
│   ├── services/
│   │   ├── indexing.service.js    # CodebaseIndexingService
│   │   ├── indexer.service.js     # Indexer class
│   │   ├── auto-indexer.service.js # AutoIndexer
│   │   ├── maintenance.service.js # CodebaseMaintenance
│   │   ├── search-router.service.js # SearchRouter
│   │   ├── grep.service.js         # GrepSearcher
│   │   ├── metadata.service.js     # SimpleMetadataStore
│   │   ├── project-analyzer.service.js
│   │   └── parser/
│   │       ├── index.js
│   │       └── fallback.js
│   ├── llm-client.js           # LLM Router HTTP client
│   ├── config.js               # Configuration loader
│   └── utils/
│       └── logger.js
├── nVDB/                       # Git submodule - Rust vector DB
├── data/                       # Index data storage
│   └── codebases/              # Per-codebase data
├── config.json                 # Service configuration
├── package.json
└── README.md
```

### Directory Reuse Strategy

The new microservice should **not copy** the nVDB submodule. Instead:

1. **Option A (Preferred)**: Keep nVDB as a git submodule reference
   ```
   cd code-indexing-service
   git submodule add <nVDB-repo-url> nVDB
   ```

2. **Option B**: Reference the existing nVDB from the parent repo
   - Symlink `code-indexing-service/nVDB` → `mcp_server/nVDB`
   - Risk: Creates tight coupling to parent repo

**Recommendation**: Option A with a separate nVDB repository

---

## 5. Configuration

### New config.json

```json
{
  "service": {
    "host": "localhost",
    "port": 3101,
    "cors": false
  },
  "storage": {
    "dataDir": "./data/codebases"
  },
  "indexing": {
    "embeddingDimension": 768,
    "maxFileSize": 1048576,
    "ignorePatterns": ["node_modules", ".git", "dist", "build", "*.log"],
    "batchSize": 25,
    "indexBatchSize": 50
  },
  "maintenance": {
    "enabled": true,
    "intervalMs": 3600000,
    "autoRefresh": true
  },
  "llm": {
    "gatewayWsUrl": "ws://localhost:3400/v1/realtime",
    "gatewayHttpUrl": "http://localhost:3400",
    "embedModel": "lmstudio-embed",
    "models": {
      "query": "glm-chat",
      "analysis": "glm-chat"
    }
  },
  "spaces": {
    "COOLKID-Work": ["\\\\COOLKID\\Work\\Work", "d:\\Work"]
  }
}
```

### Configuration Split

| Config | Current Location | New Location |
|--------|------------------|--------------|
| `service.*`, `storage.*`, `indexing.*`, `maintenance.*` | `config.json` (root) | `code-indexing-service/config.json` |
| `llm.*`, `spaces.*` | `config.json` (root) | `code-indexing-service/config.json` |
| `agents.codebase.*` | `config.json` (root) | `code-indexing-service/config.json` |
| Tool definitions | `src/agents/codebase/config.json` | API documentation only (tools become HTTP endpoints) |

---

## 6. Dependencies

### NPM Packages (New)

```json
{
  "express": "^4.18.2",
  "cors": "^2.8.5",
  "helmet": "^7.1.0",
  "express-rate-limit": "^7.1.0",
  "js-yaml": "^4.1.0"
}
```

### Existing Dependencies to Retain

```json
{
  "@modelcontextprotocol/sdk": "same version",
  "puppeteer": "same version",
  "sqlite3": "same version",
  "jose": "same version",
  "zod": "same version"
}
```

### Native Module: nVDB

The Rust nVDB binary (`nvdb-node.win32-x64-msvc.node`) is loaded at runtime via N-API. It must be compiled or provided for the target platform.

**Build requirement**: If nVDB needs recompilation:
```bash
cd nVDB
cargo build --release
# or use provided build scripts
```

---

## 7. Migration Steps

### Phase 1: Extract Core Service (Week 1)

1. **Create new repository/branch**: `code-indexing-service/`
2. **Copy files from `src/agents/codebase/`**:
   - `index.js` → `src/services/indexing.service.js`
   - `indexer.js` → `src/services/indexer.service.js`
   - `auto-index.js` → `src/services/auto-indexer.service.js`
   - `maintenance.js` → `src/services/maintenance.service.js`
   - `search-router.js` → `src/services/search-router.service.js`
   - `grep.js` → `src/services/grep.service.js`
   - `simple-metadata.js` → `src/services/metadata.service.js`
   - `project-analyzer.js` → `src/services/project-analyzer.service.js`
   - `parser/` → `src/services/parser/`
3. **Add nVDB submodule**: `git submodule add <nVDB-repo> nVDB`
4. **Create HTTP server** in `src/server.js`
5. **Create route handlers** for all endpoints
6. **Create `src/llm-client.js`** to replace direct gateway calls
7. **Test**: Index a small codebase via HTTP API

### Phase 2: Create LLM Client (Week 1)

The service connects to the LLM Gateway via WebSocket for chat operations and HTTP for embeddings. This replicates the pattern used in `src/gateway-client.js`.

```javascript
// src/llm-client.js
import { randomUUID } from 'crypto';

export class LLMClient {
  constructor(config) {
    this.wsUrl = config.gatewayWsUrl;   // ws://localhost:3400/v1/realtime
    this.httpUrl = config.gatewayHttpUrl; // http://localhost:3400
    this.embedModel = config.embedModel;
    this.models = config.models || {};

    this._ws = null;
    this._pendingRequests = new Map();
    this._isClosed = false;
    this._reconnectAttempts = 0;

    this._connect();
  }

  get connected() {
    return this._ws && this._ws.readyState === WebSocket.OPEN;
  }

  _connect() {
    if (this._isClosed) return;

    this._ws = new WebSocket(this.wsUrl);

    this._ws.onopen = () => {
      this._reconnectAttempts = 0;
    };

    this._ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.method === 'chat.delta') {
        const req = this._pendingRequests.get(msg.params.request_id);
        if (req) {
          req.response.content += msg.params.choices?.[0]?.delta?.content || '';
        }
      } else if (msg.method === 'chat.done') {
        const req = this._pendingRequests.get(msg.params.request_id);
        if (req) {
          req.resolve(req.response);
          this._pendingRequests.delete(msg.params.request_id);
        }
      } else if (msg.method === 'chat.error') {
        const req = this._pendingRequests.get(msg.params.request_id);
        if (req) {
          req.reject(new Error(msg.params.error?.message || String(msg.params.error)));
          this._pendingRequests.delete(msg.params.request_id);
        }
      }
    };

    this._ws.onclose = () => {
      if (this._isClosed) return;
      for (const req of this._pendingRequests.values()) {
        req.reject(new Error('WebSocket disconnected'));
      }
      this._pendingRequests.clear();
      const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), 30000);
      this._reconnectAttempts++;
      setTimeout(() => this._connect(), delay);
    };
  }

  _send(msg) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      throw new Error('Gateway WebSocket not connected');
    }
    this._ws.send(JSON.stringify(msg));
  }

  // Embeddings use HTTP (same as gateway-client.js)
  async embedText(text) {
    const res = await fetch(`${this.httpUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text, model: this.embedModel })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.data[0].embedding;
  }

  async embedBatch(texts) {
    const res = await fetch(`${this.httpUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: texts, model: this.embedModel })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.data.map(d => d.embedding);
  }

  // Chat/predict use WebSocket
  async predict({ prompt, systemPrompt, taskType, temperature, maxTokens, responseFormat }) {
    const model = this.models[taskType] || this.models.query || 'default';
    const response = await this.chat({
      model,
      messages: [{ role: 'user', content: prompt }],
      systemPrompt,
      maxTokens,
      temperature,
      responseFormat
    });
    return response.content;
  }

  async chat({ model, messages, systemPrompt, maxTokens, temperature, responseFormat }) {
    const id = randomUUID();
    const fullMessages = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...messages]
      : messages;

    return new Promise((resolve, reject) => {
      this._pendingRequests.set(id, { resolve, reject, response: { content: '' } });

      this._send({
        jsonrpc: '2.0',
        id,
        method: 'chat.create',
        params: {
          model,
          messages: fullMessages,
          max_tokens: maxTokens,
          temperature,
          response_format: responseFormat,
          stream: true
        }
      });
    });
  }

  close() {
    this._isClosed = true;
    if (this._ws) this._ws.close();
    for (const req of this._pendingRequests.values()) {
      req.reject(new Error('LLM client closed'));
    }
    this._pendingRequests.clear();
  }
}
```

**Key Points:**
- WebSocket for `chat.create`, `chat.append`, `chat.cancel` (real-time streaming responses)
- HTTP for `embedText()` / `embedBatch()` (batch embedding generation)
- JSON-RPC 2.0 protocol over WebSocket
- Auto-reconnect with exponential backoff
- Mirrors the existing `src/gateway-client.js` pattern

### Phase 3: Update MCP Orchestrator (Week 2)

1. **Modify `src/agent-loader.js`** to load the code-indexing-service as a remote agent or remove it
2. **Create HTTP-based tool wrappers** in the codebase agent (if keeping lightweight agent):

```javascript
// src/agents/codebase/http-client.js
export class IndexingServiceClient {
  constructor(baseUrl = 'http://localhost:3101/api/v1') {
    this.baseUrl = baseUrl;
  }

  async indexCodebase(source, name, options) {
    const response = await fetch(`${this.baseUrl}/index`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, name, options })
    });
    return response.json();
  }

  async search(codebaseId, query, strategy = 'hybrid') {
    const response = await fetch(`${this.baseUrl}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codebaseId, query, strategy })
    });
    return response.json();
  }

  // ... other methods
}
```

3. **Update `src/agents/codebase/index.js`** to delegate to HTTP client
4. **Remove local indexing code** from the codebase agent
5. **Update `config.json`** to add `codeIndexingServiceUrl`

### Phase 4: Data Migration (Week 2)

The existing index data in `data/codebases/` must be accessible to the new service:

1. **Option A (Recommended)**: Move data directory
   ```bash
   mv mcp_server/data/codebases code-indexing-service/data/
   ```

2. **Option B**: Keep in place and configure new service to read from original location
   ```json
   {
     "storage": {
       "dataDir": "d:/DEV/mcp_server/data/codebases"
     }
   }
   ```

### Phase 5: Testing & Documentation (Week 2-3)

1. Integration testing with MCP orchestrator
2. Performance benchmarking (compare before/after search latency)
3. Update documentation in `mcp_documentation/`
4. Create API documentation

---

## 8. Key Considerations

### 8.1 Communication Overhead

**Current (in-process)**:
```
Tool call → CodebaseIndexingService.method() → Direct response
```
Latency: ~1-5ms

**New (HTTP)**:
```
Tool call → HTTP POST → Microservice → Response
```
Latency: ~5-20ms (localhost)

**Mitigation**: Use HTTP keep-alive, batch requests where possible.

### 8.2 nVDB as Embedded Library

nVDB is designed as an embedded Rust library, not a separate server. This is efficient but means:
- The code-indexing-service must run on the same host as the file system
- Cannot scale horizontally for indexing (nVDB is single-writer)
- Search can be scaled horizontally if nVDB data is shared (network storage)

**For MVP**: Run as single instance. Horizontal scaling can be addressed later with read replicas if needed.

### 8.3 Data Isolation

The code-indexing-service needs access to:
- Source code files (file system)
- LLM Gateway (HTTP)
- Its own data directory

The MCP orchestrator only needs:
- Network access to the service
- No direct file system access for indexing

### 8.4 Graceful Degradation

If the code-indexing-service is down:
1. MCP orchestrator should return a clear error
2. Tools should indicate service unavailability
3. Consider caching recent search results (future enhancement)

### 8.5 Security

- Service runs on localhost only (not exposed externally)
- Rate limiting on search endpoints
- Input validation on all endpoints
- No authentication needed for localhost communication (defense in depth: network isolation)

---

## 9. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| nVDB native module compatibility | High | Test on target platforms early; provide pre-built binaries |
| Latency increase for search | Medium | Profile; optimize batch sizes; consider caching |
| Data migration loss | High | Backup before migration; test with copy first |
| Breaking changes to MCP tools | Medium | Maintain API compatibility; version the HTTP API |
| LLM Gateway availability | High | Add circuit breaker; return cached results if available |
| Concurrent write conflicts | Low | nVDB is single-writer; MCP orchestrator is single-process |

---

## 10. Success Criteria

1. **Functional**: All existing codebase indexing tools work via HTTP API
2. **Performance**: Search latency < 100ms for typical queries (p95)
3. **Reliability**: Service recovers gracefully from LLM Gateway outages
4. **Maintainability**: Clear separation of concerns; testable in isolation
5. **Observable**: Logging and status endpoints for debugging

---

## 11. Files to Modify/Create

### Create (New Service)

| File | Purpose |
|------|---------|
| `code-indexing-service/src/server.js` | Express entry point |
| `code-indexing-service/src/api/routes.js` | Route aggregation |
| `code-indexing-service/src/api/*.routes.js` | Individual route handlers |
| `code-indexing-service/src/services/*.js` | All moved services |
| `code-indexing-service/src/llm-client.js` | LLM HTTP client |
| `code-indexing-service/src/config.js` | Config loader |
| `code-indexing-service/package.json` | Dependencies |
| `code-indexing-service/config.json` | Configuration |

### Modify (MCP Server)

| File | Change |
|------|--------|
| `src/agents/codebase/index.js` | Replace implementation with HTTP client |
| `src/agents/codebase/config.json` | Remove tool definitions (API docs only) |
| `config.json` | Remove `agents.codebase`; add `codeIndexingService` URL |
| `mcp_documentation/orchestrator.md` | Update to reflect microservice architecture |

### Delete (After Migration)

| File | Reason |
|------|--------|
| `src/agents/codebase/` (most files) | Replaced by microservice |
| `src/agents/codebase/config.json` | Tool defs moved to API docs |

---

## 12. Estimated Effort

| Phase | Tasks | Estimate |
|-------|-------|----------|
| Phase 1 | Extract core service, create HTTP server | 3-4 days |
| Phase 2 | Create LLM client, test indexing | 2 days |
| Phase 3 | Update MCP orchestrator | 2-3 days |
| Phase 4 | Data migration, integration testing | 1-2 days |
| Phase 5 | Documentation, polishing | 1-2 days |
| **Total** | | **9-13 days** |
