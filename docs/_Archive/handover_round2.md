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

## Benchmark History — Three Runs

Query: `"FFMPEG streaming integration in electron"` across 66 codebases

### Performance

| Tool | Run 1 (baseline) | Run 2 (post-fix) | Run 3 (current) |
|------|-----------------|-------------------|-----------------|
| `search_keyword` | 2541ms (0 res) | 1345ms (10) | 1423ms (10) |
| `search(keyword)` | 69ms | 66ms | 84ms |
| `search(semantic)` | 299ms | 312ms | 435ms |
| `search(hybrid)` | 240ms (10) | 291ms (10) | 338ms (6) |
| `grep_codebase` | 73ms | 78ms | 81ms |
| `search_all` (66 dbs) | 8689ms | 17004ms | **12617ms** |

### Quality (search_all top 10 results)

| # | Run 1 (baseline) | Run 2 (post-fix) | Run 3 (current) |
|---|------------------|-------------------|-----------------|
| 1 | `ffmpeg_napi_interface` ✅ | `ffmpeg_napi_interface` ✅ | `web_cam:setup-ffmpeg.ps1` ✅ |
| 2 | `web_cam:setup-ffmpeg.ps1` ✅ | `web_cam:setup-ffmpeg.ps1` ✅ | `ffmpeg_napi_interface:electron_test` ✅ |
| 3 | `n_forge` ⚠️ | `n_forge` ⚠️ | `ffmpeg_napi_interface:electron_demo` ✅ |
| 4 | `n_forge` ❌ | `n_forge` ❌ | `ffmpeg_napi_interface:start.bat` ✅ |
| 5 | `web_cam` ❌ | `web_cam` ❌ | `web_cam:public/index.html` ⚠️ |
| 6 | `copilot-instructions.md` ❌ | `copilot-instructions.md` ❌ | `n_indexer:test_search.js` ⚠️ |
| 7 | `LICENSE` ❌ | `LICENSE` ❌ | `sound_app:FFmpeg WebAssembly.url` ✅ |
| 8 | `copilot-instructions.md` ❌ | `copilot-instructions.md` ❌ | `n_pm:processStats.js` ⚠️ |
| 9 | `localweb` ❌ | `localweb` ❌ | `markdown_viewer:electron-adapter.js` ✅ |
| 10 | `copilot-instructions.md` ❌ | `copilot-instructions.md` ❌ | `local_pm:electron-builder.json` ⚠️ |

**Relevant results in top 10**: 2/10 → 2/10 → **6/10**

### Detailed Run 3 Results (search_all)

| # | File | Score | Semantic | Keyword | Relevant? |
|---|------|-------|----------|---------|-----------|
| 1 | `web_cam:setup-ffmpeg.ps1` | 0.716 | 0.666 | 0.832 | ✅ FFmpeg setup script |
| 2 | `ffmpeg_napi_interface:electron_test/index.html` | 0.707 | 0.744 | 0.579 | ✅ FFmpeg + Electron test |
| 3 | `ffmpeg_napi_interface:demos/electron_demo/renderer/index.html` | 0.702 | 0.719 | 0.663 | ✅ FFmpeg Electron demo |
| 4 | `ffmpeg_napi_interface:electron_test/start.bat` | 0.683 | 0.719 | 0.000 | ✅ Electron launch script |
| 5 | `web_cam:public/index.html` | 0.681 | 0.617 | 0.832 | ⚠️ Generic HTML, keyword-boosted |
| 6 | `n_indexer:test_search.js` | 0.669 | 0.704 | 0.000 | ⚠️ Test file, not FFmpeg-related |
| 7 | `sound_app:FFmpeg WebAssembly.url` | 0.668 | 0.677 | 0.644 | ✅ FFmpeg reference |
| 8 | `n_pm:processStats.js` | 0.660 | 0.587 | 0.832 | ⚠️ Unrelated, keyword-boosted |
| 9 | `markdown_viewer:electron-adapter.js` | 0.656 | 0.653 | 0.663 | ✅ Electron adapter |
| 10 | `local_pm:electron-builder.json` | 0.656 | 0.580 | 0.832 | ⚠️ Config file, not code |

---

## What's Improved ✅

- **Boilerplate filtering works** — zero `LICENSE`, `copilot-instructions.md`, or `AGENTS.md` files in results. All four noise sources from run 1/2 are eliminated.
- **Score separation improved** — range went from 0.55–0.63 (compressed) to 0.656–0.716. Real gaps between good and mediocre matches now.
- **`search_all` faster** — 17s → 12.6s. Still 45% slower than the original 8.7s baseline but heading in the right direction.
- **`ffmpeg_napi_interface` dominates top 4** — three results from the single most relevant codebase. Correct behavior.
- **`search(hybrid)` now filters** — returns 6 results instead of 10, meaning low-quality matches are dropped rather than padded.

---

## Remaining Issues

### 1. `n_video` still absent from cross-codebase results

`n_video` (native video/audio processing via N-API + FFmpeg) is objectively the most relevant codebase to this query but never appears in search_all top 10. When searched directly:

```
n_video:README.md  semantic: 0.711  keyword: 0.063  hybrid: 0.517
```

The semantic score (0.711) is among the highest across all codebases, but keyword score is near zero. The hybrid blend still drowns strong semantic matches that lack keyword overlap. This was flagged in run 2 and persists.

**Suggestion**: The hybrid merge should protect strong semantic signals. A semantic score above 0.70 with any keyword score should rank higher than a semantic 0.58 + keyword 0.83 match.

### 2. `keywordScore: 0.832` appears on unrelated files

`web_cam:public/index.html`, `n_pm:processStats.js`, and `local_pm:electron-builder.json` all have keywordScore 0.832 — the highest in the results — but none are about FFmpeg. This is the same keyword ceiling problem from run 2, just at a higher value now.

**Suggestion**: The keyword scorer may be over-weighting common tokens ("streaming", "electron") vs rare/unique ones ("ffmpeg"). TF-IDF or BM25 would help discriminate.

### 3. `search(semantic)` regressed 435ms (was 299ms baseline)

Not critical but worth noting. If the semantic slowdown is from the quality improvements, it's an acceptable tradeoff. If it's from something else, worth investigating.

---

## Summary

| Area | Status |
|------|--------|
| `search_keyword` tokenizer | ✅ Fixed (run 2) |
| Boilerplate filtering | ✅ Fixed (run 3) |
| Score separation | ✅ Improved (run 3) |
| `search_all` performance | ⚠️ Better than run 2, still 45% slower than baseline |
| Strong semantic protection in hybrid | ❌ Still drops high-semantic/low-keyword matches |
| Keyword scoring for rare tokens | ⚠️ Better but still over-boosts common words |
| `n_video` missing | ❌ Most relevant codebase still not in top 10 |
