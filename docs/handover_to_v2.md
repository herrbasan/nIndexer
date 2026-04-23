# nIndexer: Handover to V2.0.0

**Date**: April 23, 2026
**Context**: Stable V1.0.0 Release â†’ Transition to V2 Native MCP & Real-Time Watcher

## 1. State of V1 (Stable)
The current `v1.0.0` master branch is highly stable. 
- Hybrid search correctly applies TF-IDF term density and an absolute semantic protection floor (>= 0.70).
- Boilerplate files (e.g., `package.json`, `Cargo.toml`, `README.md`) are successfully penalized.
- Recursion bugs scanning internal DB endpoints are fixed mapping `**/data/**` and `**/logs/**` exclusions.

## 2. V2 Project Objectives (The Pivot)
The V2 codebase (which will live in a separate directory) will execute the roadmap defined in `docs/mcp_realtime_spec.md`. 
The core upgrades will be:
1. **Native MCP Server:** Implement a `stdio` MCP transport, removing the need for a middleman orchestrator.
2. **Just-In-Time (JIT) Indexing:** Return structured MCP responses when an unindexed codebase is queried, allowing the LLM to autonomously trigger `index_codebase`.
3. **Real-time Watch Mode:** Implement OS-level filesystem watchers (`fs.watch` or `chokidar`) to immediately queue and embed file changes on `CTRL+S`.
4. **Local Embeddings (OpenAI-compatible):** Refactor the embedding client to target standard OpenAI-compatible endpoints (LM Studio, Ollama).
5. **Batteries-Included (Windows):** Bundle `llama_server.exe` as a zero-config local fallback.

## 3. Key Implementation Warnings for V2
Based on the objective architectural review, the V2 developer must carefully handle these edge cases:
- **File Watcher Floods:** Do not use a simple timeout for debouncing. Implement a bounded concurrency queue (`async.queue`) for embeddings to prevent DDOSing the local `llama_server.exe` during "Find & Replace All" operations.
- **Hardware-Aware Limits:** Expose a config for max concurrent embedding requests (e.g., 100 for RTX 4090, 2 for low-end machines).
- **Dimensionality Safety:** Store the embedding vector dimension size on the first codebase index. If the user swaps their embedding model later (e.g., 768 dim to 1024 dim), the DB will crash unless a re-index is forced.
- **Structured MCP Errors:** When guiding an LLM to index a codebase, return a structured `error` payload indicating `"available_tools": ["index_codebase"]` rather than a plain string, so the LLM gracefully handles the missing state.

## 4. First Steps in the New Workspace
1. Copy the repository to the new V2 folder directory.
2. Bump `version` to `2.0.0` in `package.json`.
3. Scaffold the base MCP `stdio` server alongside the existing WebSocket/HTTP logic in `src/server.js`.
4. Refactor `llm-client.js` to target the OpenAI embeddings format.