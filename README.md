# nIndexer

An MCP-native microservice for vector-based semantic search, keyword indexing, and file analysis of codebases. Built with native Node.js (no external dependencies).

## Quick Start

```bash
# Start the HTTP/SSE server
node src/server.js

# Server runs at:
# - HTTP: http://localhost:3666 (health check)
# - SSE: http://localhost:3666/mcp/sse (MCP protocol endpoint)
```

## Features

- **Semantic Search**: Vector-based similarity search using embeddings
- **Keyword Search**: Fast indexed keyword and content search
- **Live Grep**: Regex search via ripgrep
- **Code Analysis**: LLM-powered project description and file prioritization
- **Auto-Maintenance**: Detects stale indexes and refreshes automatically
- **Auto-Discovery**: Scans configured root directories for projects

## Documentation

See [documentation/nIndexer_documentation.md](documentation/nIndexer_documentation.md) for full API reference.

## Configuration

Edit `config.json` to adjust service settings:

```json
{
  "service": { "host": "localhost", "port": 3666 },
  "storage": { "dataDir": "./data/codebases", "trashDir": "./data/trash" },
  "llama": {
    "port": 42718,
    "modelPath": "bin/llama/models/jina-embeddings-v2-base-code-Q5_K_M.gguf"
  },
  "discovery": {
    "roots": ["C:\\Projects\\"],
    "scanIntervalMs": 3600000
  }
}
```

## Project Structure

```
nIndexer/
├── src/
│   ├── server.js              # HTTP/SSE server
│   ├── mcp-stdio.js           # Stdio transport for MCP clients
│   ├── api/
│   │   └── mcp-router.js      # JSON-RPC message routing
│   └── services/              # Core services
├── nVDB/                      # Rust vector DB (submodule)
├── nLogger/                   # Logging utility (submodule)
├── data/
│   ├── codebases/             # Indexed data
│   └── trash/                 # Removed codebases
├── documentation/             # User documentation
└── config.json                # Service configuration
```
