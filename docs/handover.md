# nIndexer Integration — Handover Notes

**Date**: 2026-04-22
**From**: MCP Server Orchestrator maintainer
**To**: nIndexer service maintainer

---

## MCP Server Changes (Commit ea9bc9b)

- **Tool schemas** (`config.json`): Added `analyze` to `index_codebase`/`refresh_codebase`, added `reindex` + `analyze` to `run_maintenance`
- **Dead code removed** (`index.js`): ~360 lines of duplicated `getTools()`/`handlesTool()`/`callTool()` removed
- **`nindexer-client.js`**: No changes needed — all 19 endpoints already in sync

---

## `search_keyword` — Confirmed Fixed ✅

Tokenizer now matches "FFMPEG" correctly. Went from 0 results / 2541ms → 10 results / 1345ms.

---

## `search_all_codebases` — Quality + Performance Issues ⚠️

### The Problem

After the nIndexer upgrade, `search_all_codebases` got **2x slower** (8.7s → 17s) and result quality **did not improve** to justify the cost.

### Benchmark

Query: `"FFMPEG streaming integration in electron"` across 66 codebases, `perCodebaseLimit: 3`

| Metric | Before | After |
|--------|--------|-------|
| Duration | 8689ms | **17004ms** |
| Total matches | 192 | 192 |
| Codebases with hits | 65 | 65 |
| Top result score | 0.63 | 0.63 |

Same query, same result count, 2x the time.

### Top 10 Results (post-upgrade)

| # | File | Score | Relevant? |
|---|------|-------|-----------|
| 1 | `ffmpeg_napi_interface:electron_test/index.html` | 0.633 | ✅ FFmpeg + Electron |
| 2 | `web_cam:setup-ffmpeg.ps1` | 0.606 | ✅ FFmpeg setup |
| 3 | `n_forge:forge/scripts/test-electron-boots.js` | 0.586 | ⚠️ Electron, no FFmpeg |
| 4 | `n_forge:host/app/index.html` | 0.581 | ❌ Generic HTML |
| 5 | `web_cam:public/index.html` | 0.572 | ❌ Generic HTML |
| 6 | `x_electron_libre_mon:.github/copilot-instructions.md` | 0.566 | ❌ Copilot instructions |
| 7 | `slide:out/imageslideviewer-win32-x64/LICENSE` | 0.562 | ❌ LICENSE file |
| 8 | `electron_libre_mon:.github/copilot-instructions.md` | 0.560 | ❌ Copilot instructions |
| 9 | `localweb:index.js` | 0.556 | ❌ Generic server |
| 10 | `local_pm:.github/copilot-instructions.md` | 0.555 | ❌ Copilot instructions |

**6 out of 10 results are noise.**

### Root Causes

#### 1. No boilerplate/metadata file filtering

`LICENSE`, `.github/copilot-instructions.md`, `README.md` files rank alongside actual code. These are present in nearly every codebase and match on common tokens without carrying relevant content.

**Suggestion**: Add a file-importance weighting that penalizes known boilerplate patterns:
- `LICENSE*`, `*.license` → heavy penalty
- `.github/copilot-instructions.md`, `AGENTS.md` → medium penalty (documentation, not code)
- `README.md` → slight penalty (often relevant but not code)

Alternatively, expose a `fileTypes` filter (e.g., `{ fileTypes: ["code"] }`) that excludes markdown/text/license files.

#### 2. Keyword score ceiling

Most results have `keywordScore: 0.4667` — a suspiciously uniform value. This looks like generic token overlap (common words like "streaming", "electron") producing a fixed keyword contribution regardless of actual relevance. The keyword scorer isn't discriminating.

Compare:
- `ffmpeg_napi_interface:electron_test/index.html` → keywordScore: **0.375** (actually about FFmpeg + Electron)
- `slide:out/.../LICENSE` → keywordScore: **0.4667** (a LICENSE file)

The LICENSE file has a *higher* keyword score than the actually relevant file. That's inverted.

**Suggestion**: The keyword scorer should weight rare/unique tokens (like "ffmpeg") higher than common ones ("streaming", "electron"). TF-IDF or BM25 would help here.

#### 3. Score compression / no separation

All 10 results score between 0.55 and 0.63. There's no clear gap between "good match" and "poor match". A good search should show a steep dropoff — e.g., top 3 at 0.8+, rest at 0.3 or below.

**Suggestion**: Normalize or calibrate the hybrid score so that genuinely relevant results score significantly higher than noise. A minimum score threshold (e.g., drop results below 0.5) would also clean up the tail.

#### 4. Best match missing from top 10

`n_video` (native video/audio processing via N-API + FFmpeg — the single most relevant codebase) didn't make the top 10 at all. When searched directly:

```
n_video:README.md          semantic: 0.711  keyword: 0.063  hybrid: 0.517
```

High semantic score (0.71 — highest across all codebases) but near-zero keyword score (0.06) kills it in the hybrid blend. Meanwhile noise files with keyword 0.47 but semantic 0.60 rank above it.

**Suggestion**: The hybrid merge should respect semantic signal more strongly. A file with semantic 0.71 and keyword 0.06 is more relevant than one with semantic 0.60 and keyword 0.47. Consider a weighted blend that doesn't let a mediocre keyword score override a strong semantic match.

### Summary of Suggested nIndexer Improvements

| Priority | Change | Impact |
|----------|--------|--------|
| **High** | Penalize or filter boilerplate files (LICENSE, copilot-instructions.md) | Removes ~50% of noise |
| **High** | Fix keyword scorer to weight rare tokens (TF-IDF/BM25) | "ffmpeg" should dominate over "streaming" |
| **Medium** | Adjust hybrid merge to protect strong semantic signals | Prevents best matches from being drowned |
| **Medium** | Add minimum score threshold for cross-codebase results | Cuts noise tail |
| **Low** | Investigate 2x performance regression | 17s for 66 codebases is slow |

---

## Single-Codebase Search — Working Well ✅

| Strategy | Time | Quality |
|----------|------|---------|
| `search(keyword)` | 66ms | Fast, accurate for name lookups |
| `search(hybrid)` | 291ms | Good blend |
| `search(semantic)` | 312ms | Solid conceptual matching |
| `grep_codebase` | 78ms | Always current, good for regex |
| `search_keyword` | 1345ms | Fixed, but slower than `search(keyword)` |

No issues with single-codebase search performance or quality.
