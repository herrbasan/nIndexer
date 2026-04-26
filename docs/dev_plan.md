# Development Plan: Native MCP & Real-Time Indexing

Based on the specifications in `mcp_realtime_spec.md`, here is the development plan and current progress.

### 🟢 What We Have Done Already (Completed)
The core infrastructure of the specification has successfully been deployed and proven out:
1. **Local Embeddings ("Batteries Included")**:
   - `llm-client.js` is fully refactored to route towards standard OpenAI-compatible API contracts.
   - The fallback for Windows is complete: `llama-server.exe` is successfully integrated, running `jina-embeddings-v2` locally on port 42718 without network hop API costs.
2. **Real-Time Watch Mode**:
   - The native `fs.watch` file listeners have been added to `src/services/maintenance.service.js` under the `watchCodebase` method.
   - Event handling handles adds/changes recursively and debouncing (5-second timeout delay) is implemented to prevent `CTRL+S` spamming.
3. **Multi-Codebase Architecture**:
   - The `nIndexer` API natively maintains isolated states between different loaded workspaces instead of running in a standalone generic mode.
4. **MCP Protocol Layer (SSE)**:
   - The legacy custom WebSocket endpoint has officially been converted to a fully compliant MCP Server-Sent Events (SSE) server endpoint (`/mcp/sse` & `/mcp/message`).
   - The JSON-RPC translation map (`src/api/mcp-router.js`) accurately exposes the required native endpoints (`search_keyword`, `index_codebase`, etc).
5. **Just-In-Time (JIT) Indexing Workflow Integration**:
   - `mcp-router.js` intercepts unindexed codebase validation errors and emits conversational soft-fails.
   - The AI receives standard natural-language instructions to self-correct by calling `index_codebase` automatically.
6. **Hardware-Aware Embedding Limits**:
   - Implemented a `Promise.all` concurrent execution bounded by a `maxConcurrentRequests` semaphore queue in `llm-client.js`.
   - `src/services/indexer.service.js` now processes vectors cleanly against `llama-server.exe` bound by user-configurable concurrency limits.

7. **Standardize MCP `stdio` Transport (Bonus Feature)**:
   - Added `src/mcp-stdio.js` to run the indexer using standard streams without HTTP setup.
   - Piped `process.stdin` through JSON parsing straight into JSON-RPC response formats securely handling asynchronous events cleanly.
   - Forced `logger` to output specifically to `stderr` preventing stdout stream clobbering to MCP client payloads.
8. **Production Hardening (Completed)**:
   - Confirmed file deletions via JIT watcher organically decouple DB caching mappings gracefully handling `nVDB` memory eviction accurately via `collection.delete`.
   - Supplied a functional architecture drop-in configuration example targeting standard Claude Desktop implementations via `docs/claude_desktop_config.json`.

---

### 🟢 Objectives Concluded
All tasks complete. The `nIndexer_V2` platform natively operates in real-time across both isolated internal SSE network ports and raw `stdio` local process piping while abiding strictly by standard Model Context Protocol boundaries seamlessly reacting to IDE file modifications incrementally.