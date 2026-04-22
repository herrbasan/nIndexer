/**
 * Search Router - Coordinates semantic and keyword search
 * 
 * Currently a thin wrapper since:
 * - Semantic search: handled by nVDB
 * - Keyword search: handled by SQLite FTS5
 * - Hybrid ranking: combines both scores
 */

export class SearchRouter {
  /**
   * Combine semantic and keyword results
   * 
   * Scoring:
   * - Semantic score: 0-1 from nVDB (higher is better)
   * - Keyword score: 0-1 from FTS5 rank (converted)
   * - Combined: weighted sum (default 0.7 semantic, 0.3 keyword)
   */
  combineResults(semanticResults, keywordResults, weights = { semantic: 0.7, keyword: 0.3 }) {
    const scores = new Map();

    // Normalize semantic scores (already 0-1)
    for (const r of semanticResults) {
      scores.set(r.path, { semantic: r.score, keyword: 0, data: r });
    }

    // Normalize keyword scores (FTS5 rank is negative, lower is better)
    if (keywordResults.length > 0) {
      const maxRank = Math.max(...keywordResults.map(r => Math.abs(r.rank)));
      for (const r of keywordResults) {
        const normalized = maxRank > 0 ? 1 - (Math.abs(r.rank) / maxRank) : 0;
        const existing = scores.get(r.path);
        if (existing) {
          existing.keyword = Math.max(existing.keyword, normalized);
        } else {
          scores.set(r.path, { semantic: 0, keyword: normalized, data: { path: r.path } });
        }
      }
    }

    // Calculate combined scores with smart penalties and boosts
    const combined = [];
    for (const [path, scores_data] of scores) {
      let penalty = 1.0;
      const lowerPath = path.toLowerCase();
      
      // Known boilerplate noise penalties
      if (lowerPath.includes('node_modules') || lowerPath.includes('.git/')) {
        penalty = 0.1;
      } else if (lowerPath.includes('license') || lowerPath.endsWith('.license')) {
        penalty = 0.2;
      } else if (lowerPath.includes('copilot-instructions.md') || lowerPath.includes('agents.md')) {
        penalty = 0.5;
      } else if (lowerPath.endsWith('readme.md')) {
        penalty = 0.8;
      } else if (lowerPath.includes('package-lock.json') || lowerPath.includes('yarn.lock') || lowerPath.includes('cargo.lock')) {
        penalty = 0.1;
      }

      // Base hybrid score
      let semanticPart = scores_data.semantic * weights.semantic;
      let keywordPart = scores_data.keyword * weights.keyword;
      let combinedScore = semanticPart + keywordPart;

      // Smart semantic overriding (Don't let low keyword score drag down an excellent semantic hit)
      if (scores_data.semantic > 0.65) {
        combinedScore = Math.max(combinedScore, scores_data.semantic * 0.95);
      }

      combinedScore *= penalty;

      // Noise floor culling for cross-codebase scale
      if (combinedScore >= 0.45) {
        combined.push({
          ...scores_data.data,
          score: combinedScore,
          semanticScore: scores_data.semantic * penalty,
          keywordScore: scores_data.keyword * penalty
        });
      }
    }

    // Sort by combined score
    combined.sort((a, b) => b.score - a.score);

    return combined;
  }

  /**
   * Apply post-filters to results
   */
  filterResults(results, filters) {
    return results.filter(r => {
      if (filters.language && r.language !== filters.language) return false;
      if (filters.pathPattern && !r.path.includes(filters.pathPattern)) return false;
      if (filters.minScore && r.score < filters.minScore) return false;
      return true;
    });
  }
}
