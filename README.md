# nIndexer

A WebSocket-first microservice for vector-based semantic search, keyword indexing, and file analysis of codebases. Built with native Node.js (no external dependencies).

## Quick Start

```bash
# Start the server
node src/server.js

# Server runs at:
# - HTTP: http://localhost:3666 (health check only)
# - WebSocket: ws://localhost:3666
```

## Features

- **Semantic Search**: Vector-based similarity search using embeddings
- **Keyword Search**: Fast indexed keyword and content search
- **Live Grep**: Regex search via ripgrep
- **Code Analysis**: LLM-powered project description and file prioritization
- **Auto-Maintenance**: Detects stale indexes and refreshes automatically

## Documentation

See [documentation/nIndexer_documentation.md](documentation/nIndexer_documentation.md) for full API reference.

## Configuration

1. Edit `data/codebases.json` to add codebases to index:
```json
{
  "codebases": {
    "my-project": "//server/share/path/to/project"
  }
}
```

2. Edit `config.json` to adjust service settings (port, LLM gateway, etc.)

## Project Structure

```
nIndexer/
├── src/
│   ├── server.js              # WebSocket/HTTP server
│   ├── api/router.js          # JSON-RPC message routing
│   └── services/              # Core services
├── nVDB/                      # Rust vector DB (submodule)
├── data/
│   ├── codebases/             # Indexed data
│   ├── codebases.json         # Codebase definitions
│   └── trash/                # Removed codebases
├── documentation/              # User documentation
└── config.json                # Service configuration
```
