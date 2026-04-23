# Specification: Native MCP & Real-Time Indexing

## 1. Executive Summary
This specification outlines the architectural pivot of `nIndexer` from a custom WebSocket backend service into a **native Model Context Protocol (MCP) server**. 

Accompanied by this structural shift are two major feature additions: 
1. **Real-Time Watch Mode** for instantaneous vector updates upon file saves.
2. **Local Embedding execution** (via `llama-cpp-gateway`) to eliminate the API cost of continuous indexing.

---

## 2. Architectural Pivot: Native MCP Endpoint
**Current Architecture:** `Client` â†’ `mcp_server` (Middleman) â†’ `nIndexer` (Custom WS/HTTP).
**Target Architecture:**
`nIndexer` will directly implement the standard MCP JSON-RPC protocol (via `stdio` or `SSE`), eliminating the need for an intermediary orchestrator to expose its tools.

- Tools like `search_codebase`, `search_keyword`, and `analyze_codebase` become native MCP tools.
- Benefits: Eliminates a network hop, reduces points of failure, and standardizes deployment for environments like Claude Desktop, Cursor, or VS Code MCP extensions.

---

## 3. Operational Modes
`nIndexer` will support two distinct execution paths to cater to different developer workflows:

### Path A: Single-Codebase Mode (Standalone)
Designed to be spun up per-project continuously by an IDE or AI client.
- **Trigger:** Launched via a command like `nindexer --mode single --path .`
- **Scope:** Binds completely to the current workspace directory.
- **State:** Stores its `nVDB` index in a local `.nindexer/` hidden folder (or a centralized but project-hashed OS temp directory).
- **Lifecycle:** Ephemeral or bound to the lifecycle of the IDE. Starts when the project opens, stops when closed.
- **Advantages:** Perfect isolation, zero global configuration necessary, instantly plug-and-play for any new repository.

### Path B: Multi-Codebase Mode (Daemon)
The current operational model, enhanced for standard MCP.
- **Trigger:** Launched globally (e.g., `nindexer --mode daemon`).
- **Scope:** Scans configured root directories for multiple projects globally.
- **State:** Stores all `nVDB` indices in a centralized `data/codebases/` directory.
- **Lifecycle:** Always-on background service.
- **Advantages:** Allows an AI agent to search across *all* of the developer's projects simultaneously (e.g., retrieving references from an older project into the current one).

---

## 4. Real-Time Watch Mode
To eliminate "index staleness" during an active coding session:
- **File System Watcher:** Integrate a lightweight watcher (native `fs.watch` or `chokidar`) on active directories.
- **Event Handling:** 
  - On `change` or `add` events, the file is queued for immediate re-embedding.
  - On `unlink` (delete), the document vector is immediately dropped from `nVDB`.
- **Debouncing:** Save events (`CTRL+S`) are debounced (e.g., 2000ms delay) to ensure mid-typing saves don't spam the indexer.

---

## 5. Local Embeddings (`llama-cpp-gateway`)
Real-time indexing dictates that embeddings must be free and incredibly fast. Hitting OpenAI for every `CTRL+S` would quickly drain API budgets.
- **Integration:** `nIndexer` will natively target the local `llama-cpp-gateway` wrapper for embeddings (utilizing models like `nomic-embed-text-v1.5`).
- **Zero Cost:** Infinite document updates without API billing.
- **Zero Latency:** Local-to-local HTTP requests complete in milliseconds.
- **Privacy:** Enterprise/proprietary code never leaves the host machine.
- **Fallback:** Allow configuration to optionally fall back to cloud providers only if the local gateway is unreachable.

---

## 6. Implementation Roadmap
1. **MCP Protocol Layer:** Implement standard `stdio` MCP transport alongside the existing WS routes, converting the current API map into standard MCP tool schemas.
2. **CLI & Bootstrapping:** Program the initialization logic to accept `--mode single` vs `--mode daemon` flags.
3. **LLM Gateway Pivot:** Configure `llm-client.js` to natively understand and route requests to `llama-cpp-gateway`.
4. **Watch Listeners:** Attach file watchers to the loaded codebase directories and hook them directly into the current `indexer.service.js` single-file update methods.