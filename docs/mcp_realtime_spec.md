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

## 3. Operational Model: Multi-Codebase & JIT Indexing
Instead of restricting the service to a "single codebase" standalone mode, `nIndexer` will operate globally as an always-on **Multi-Codebase Server**. It will serve both the custom WebSocket API for existing integrations while simultaneously providing an MCP-compatible endpoint.

### Just-In-Time (JIT) Indexing Workflow
Designed for completely frictionless integration with an AI client (like an IDE chat extension):
- **Querying:** An LLM invokes a search tool on a specific codebase or directory path.
- **Missing Index Handling:** If the codebase is not yet indexed, the server does not fail outright. Instead, it returns a descriptive message to the LLM indicating that the codebase hasn't been scanned, pointing the LLM to the available `index_codebase` tool.
- **Autonomous Indexing:** The LLM can then autonomously (or after prompting the user) invoke the `index_codebase` tool to build the index on the fly.
- **Result:** Zero manual configuration. The AI seamlessly handles discovery and indexing organically as part of the conversation.

---

## 4. Real-Time Watch Mode
To eliminate "index staleness" during an active coding session:
- **File System Watcher:** Integrate a lightweight watcher (native `fs.watch` or `chokidar`) on active directories.
- **Event Handling:** 
  - On `change` or `add` events, the file is queued for immediate re-embedding.
  - On `unlink` (delete), the document vector is immediately dropped from `nVDB`.
- **Debouncing:** Save events (`CTRL+S`) are debounced (e.g., 2000ms delay) to ensure mid-typing saves don't spam the indexer.

---

## 5. Embeddings: OpenAI-Compatible Target & "Batteries Included"
Real-time indexing dictates that embeddings must be free and incredibly fast. Hitting cloud-based OpenAI models for every `CTRL+S` sequence would quickly drain API budgets.
- **Primary Workflow (OpenAI-Compatible Target):** `nIndexer` assumes the user will provide a standard OpenAI-compatible embedding endpoint (e.g., LM Studio, Ollama, vLLM, or native OpenAI API). The user simply configures standard endpoint details (`host`, `model_name`). This ensures complete cross-platform flexibility and lets users leverage their existing local LLM infrastructure.
- **Convenience Fallback (Windows Only):** As a fallback for Windows users without an existing local AI stack, `nIndexer` will include a vendor script to pull down the precompiled `llama_server.exe` binary from the `llama-cpp-gateway` project. It will seamlessly spawn this binary to provide a zero-config, "batteries included" local vector model.
- **Hardware-Aware Concurrency limits:** Because local GPU hardware VRAM heavily dictates throughput, the maximum number of concurrent embedding API calls will be user-configurable. High-end GPUs (e.g., RTX 4090) may comfortably support a sweet spot of ~100 concurrent requests to maximize VRAM utilization, whereas lower-end machines can be dialed down to prevent out-of-memory crashes.
- **Zero Cost & Zero Latency:** Pointing to local inference allows infinite document updates without API billing, completing local-to-local HTTP requests in milliseconds.
- **Privacy:** Enterprise/proprietary code never leaves the host machine for generating vector hashes.

---

## 6. Implementation Roadmap
1. **MCP Protocol Layer:** Implement standard `stdio` MCP transport alongside the existing WS routes, converting the current API map into standard MCP tool schemas.
2. **Just-In-Time Indexing Flow:** Adjust search endpoints to return soft-fail responses with `index_codebase` recommendations when targeting an unindexed path.
3. **Embeddings Gateway Refactor:** Configure `llm-client.js` to route via standardized OpenAI API contracts, specifically targeting local inferencing (Ollama, LM Studio) or the natively spawned `llama_server.exe`.
4. **Watch Listeners:** Attach file watchers to the loaded codebase directories and hook them directly into the current `indexer.service.js` single-file update methods.