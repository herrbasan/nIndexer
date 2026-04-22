# nIndexer Integration — Handover Notes (Final)

**Date**: 2026-04-22
**From**: MCP Server Orchestrator maintainer
**To**: nIndexer service maintainer

---

## MCP Server Changes (Commit ea9bc9b)

- **Tool schemas** (`config.json`): Added `analyze` to `index_codebase`/`refresh_codebase`, added `reindex` + `analyze` to `run_maintenance`
- **Dead code removed** (`index.js`): ~360 lines of duplicated `getTools()`/`handlesTool()`/`callTool()` removed
- **`nindexer-client.js`**: No changes needed — all 19 endpoints already in sync

---

## Final Benchmark

Query: `"FFMPEG streaming integration in electron"` across 66 codebases

### Single-Codebase Search

| Tool | Time | Notes |
|------|------|-------|
| `search(keyword)` | **66ms** | Fast name/exact matching |
| `search(hybrid)` | **397ms** (7 results) | Filters low-quality matches |
| `search(semantic)` | **457ms** | Intentional: `top_k` raised to `limit*3` for better recall |
| `grep_codebase` | **80ms** | Always current, cached |
| `search_keyword` | **1374ms** | Test artifact — sequential WS calls. Locally 9-19ms per nIndexer |

### Cross-Codebase Search (search_all)

**13273ms** across 66 codebases (~201ms/codebase average). This is the correct baseline — the original 8.7s was a loop termination bug causing early exit.

| # | File | Score | Sem | Kw | Verdict |
|---|------|-------|-----|-----|---------|
| 1 | `ffmpeg_napi_interface:electron_test/index.html` | 0.765 | 0.744 | 0.814 | ✅ FFmpeg + Electron |
| 2 | `ffmpeg_napi_interface:electron_test/start.bat` | 0.719 | 0.719 | 0.000 | ✅ Electron launch |
| 3 | `ffmpeg_napi_interface:electron_demo/renderer/index.html` | 0.719 | 0.719 | 0.543 | ✅ FFmpeg demo |
| 4 | `n_video:scripts/download-ffmpeg.js` | 0.710 | 0.645 | 0.863 | ✅ FFmpeg download script |
| 5 | `n_indexer:test_search.js` | 0.704 | 0.704 | 0.000 | ⚠️ Test file |
| 6 | `web_cam:setup-ffmpeg.ps1` | 0.688 | 0.666 | 0.738 | ✅ FFmpeg setup |
| 7 | `n_pm:scripts/start.js` | 0.662 | 0.641 | 0.713 | ⚠️ Generic |
| 8 | `n_video:docs/nVideo_dev_plan.md` | 0.654 | 0.688 | 0.000 | ✅ Video processing |
| 9 | `web_cam:public/index.html` | 0.653 | 0.617 | 0.738 | ⚠️ Generic HTML |
| 10 | `n_video:documentation/STREAMING.md` | 0.651 | 0.686 | 0.000 | ✅ Streaming docs |

**Relevant: 7/10** · **Zero boilerplate** (no LICENSE, copilot-instructions.md, package.json)

---

## Quality Journey (5 Runs)

| Metric | Run 1 | Run 2 | Run 3 | Run 4 | Run 5 |
|--------|-------|-------|-------|-------|-------|
| Relevant in top 10 | 2/10 | 2/10 | 6/10 | 7/10 | **7/10** |
| Boilerplate files | 4 | 4 | 0 | 0 | **0** |
| `n_video` in results | ❌ | ❌ | ❌ | ✅ (#4,#8) | ✅ (#4,#8,#10) |
| Manifest files in top 10 | — | — | — | 1 | **0** |
| Top codebase correct | ✅ | ✅ | ✅ | ✅ | ✅ |
| Score range | 0.55–0.63 | 0.55–0.63 | 0.65–0.72 | 0.65–0.76 | **0.65–0.77** |

---

## Fixes Applied (by nIndexer team)

| Fix | Run | What changed |
|-----|-----|-------------|
| `search_keyword` tokenizer | 2 | Case-insensitive token matching for "FFMPEG" |
| Boilerplate filtering | 3 | Penalty for LICENSE, copilot-instructions.md, AGENTS.md |
| Score separation | 3 | Wider gap between signal and noise |
| Semantic protection bracket | 4 | Files with semantic ≥ 0.70 guaranteed to retain that score |
| Term density weighting | 4 | Multi-term matches boosted, single-token matches penalized |
| `top_k` increase | 4 | `limit*2` → `limit*3` for deeper nearest-neighbor retrieval |
| Manifest penalties | 4 | 0.3 multiplier for package.json, Cargo.toml, .lock files |

---

## Known Minor Items (non-blocking)

1. **`search_keyword` appears 1374ms via MCP** — this is a WebSocket test harness artifact (sequential calls). nIndexer processes keyword search in 9-19ms locally.

2. **`search(semantic)` ~450ms** — intentional tradeoff for `top_k=limit*3`. Worth it for the recall improvement.

---

## MCP Client → nIndexer API Coverage

All 19 endpoints verified working. No outstanding integration issues.

| MCP Tool | nIndexer Method | Status |
|----------|----------------|--------|
| `list_codebases` | `list_codebases` | ✅ |
| `index_codebase` | `index_codebase` | ✅ |
| `refresh_codebase` | `refresh_codebase` | ✅ |
| `remove_codebase` | `remove_codebase` | ✅ |
| `search_codebase` | `search` | ✅ |
| `search_semantic` | `search_semantic` | ✅ |
| `search_keyword` | `search_keyword` | ✅ |
| `grep_codebase` | `grep_codebase` | ✅ |
| `search_all_codebases` | `search_all_codebases` | ✅ |
| `get_file_tree` | `get_file_tree` | ✅ |
| `get_file_info` | `get_file_info` | ✅ |
| `get_files_info` | Multiple `get_file_info` calls | ✅ |
| `get_file` | `get_file` | ✅ |
| `check_codebase_status` | `check_codebase_status` | ✅ |
| `check_file_stale` | `get_file` (stale check) | ✅ |
| `run_maintenance` | `run_maintenance` | ✅ |
| `get_maintenance_stats` | `get_maintenance_stats` | ✅ |
| `analyze_codebase` | `analyze_codebase` | ✅ |
| `get_codebase_description` | `get_codebase_description` | ✅ |
| `get_prioritized_files` | `get_prioritized_files` | ✅ |
