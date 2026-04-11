/**
 * Codebase Indexing Service
 * 
 * Fast semantic code search using nDB vector database.
 * 
 * Architecture:
 * - nVDB: Vector storage and similarity search
 * - SQLite: Metadata (mtimes, hashes, file info)
 * - Tree-sitter: Code structure extraction
 * - ripgrep: Live exact text search
 */

import { Database } from '../../nVDB/napi/index.js';
import { SimpleMetadataStore } from './metadata.service.js';
import { Indexer } from './indexer.service.js';
import { SearchRouter } from './search-router.service.js';
import { GrepSearcher } from './grep.service.js';
import { CodebaseMaintenance } from './maintenance.service.js';
import { analyzeProject, isAnalysisStale, getPrioritizedFiles } from './project-analyzer.service.js';
import { getLogger } from '../utils/logger.js';
import path from 'path';
import fs from 'fs/promises';

const logger = getLogger();

const DEFAULT_CONFIG = {
  dataDir: 'data/codebases',
  trashDir: 'data/trash',
  embeddingDimension: 3072, // Gemini embeddings dimension
  // embeddingModel is read from environment or config - no hardcoded default
  // This ensures it matches the router's configured embedding provider
  maxFileSize: 1024 * 1024, // 1MB
  ignorePatterns: [] // Patterns must be provided in config.json
};

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp', '.tiff', '.tif',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flac', '.ogg', '.webm',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.sqlite', '.db', '.idx'
]);

function _matchesExtension(filePath, filter) {
  if (!filter) return true;
  const ext = '.' + filePath.split('.').pop().toLowerCase();
  if (filter.includeExtensions?.length > 0) {
    return filter.includeExtensions.includes(ext);
  }
  if (filter.excludeExtensions?.length > 0) {
    return !filter.excludeExtensions.includes(ext);
  }
  return true;
}

export class CodebaseIndexingService {
  constructor(config = {}, llmRouter) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.router = llmRouter;
    this.indexes = new Map(); // name -> { db, collection, metadata }
    this.indexer = new Indexer(this.config, llmRouter);
    this.searchRouter = new SearchRouter();
    this.grepSearcher = new GrepSearcher();
    this.progressCallback = null;

    // Initialize maintenance module
    this.maintenance = new CodebaseMaintenance(this, config.maintenance);

    // Store spaces configuration for path resolution
    this.spaces = config.spaces || {};

    // Preload all codebases into memory for fast global search
    this.preloaded = false;
  }
  
  /**
   * Preload all codebases into memory (nVDB is in-memory, this loads from disk once)
   */
  async preloadAll() {
    if (this.preloaded) return;
    
    const start = Date.now();
    const all = await this.listCodebases();
    logger.info(`Preloading ${all.length} codebases into memory`, { count: all.length }, 'CodebaseIndexing');
    
    // Load in batches to avoid overwhelming the system
    const batchSize = 20;
    for (let i = 0; i < all.length; i += batchSize) {
      const batch = all.slice(i, i + batchSize);
      await Promise.all(batch.map(cb => 
        this._getCodebase(cb.name).catch(() => null)
      ));
    }
    
    this.preloaded = true;
    logger.info(`Preloaded ${all.length} codebases`, { count: all.length, durationMs: Date.now() - start }, 'CodebaseIndexing');
  }
  
  /**
   * Resolve a project path using spaces configuration
   * 
   * Supports:
   * - Absolute path: "D:\\Projects\\MyApp" or "\\\server\\share\\project"
   * - Space + project: { space: "COOLKID-Work", project: "MyApp" }
   *   -> Resolves to first accessible path from space config
   */
  async resolveSourcePath(args) {
    // If absolute source path provided, use it directly
    if (args.source) {
      return args.source;
    }
    
    // Otherwise resolve from space + project
    if (!args.space) {
      throw new Error('Either "source" (absolute path) or "space" (space name) is required');
    }
    
    const spaceConfig = this.spaces[args.space];
    if (!spaceConfig) {
      throw new Error(`Unknown space: "${args.space}". Available: ${Object.keys(this.spaces).join(', ')}`);
    }
    
    // spaceConfig is an array of paths: [UNC, local]
    // Try each path and use the first one that exists
    const projectName = args.project || args.name;
    
    for (const basePath of spaceConfig) {
      const fullPath = path.join(basePath, projectName);
      
      try {
        const stats = await fs.stat(fullPath);
        if (stats.isDirectory()) {
          return fullPath;
        }
      } catch {
        // Path doesn't exist or isn't accessible, try next
        continue;
      }
    }
    
    throw new Error(
      `Could not find project "${projectName}" in space "${args.space}". ` +
      `Tried: ${spaceConfig.map(p => path.join(p, projectName)).join(', ')}`
    );
  }
  
  /**
   * Start automatic maintenance cycle
   */
  startMaintenance() {
    this.maintenance.start();
  }
  
  /**
   * Stop automatic maintenance cycle
   */
  stopMaintenance() {
    this.maintenance.stop();
  }
  
  setProgressCallback(callback) {
    this.progressCallback = callback;
  }

  /**
   * List available spaces from configuration
   */
  async listSpaces() {
    return Object.entries(this.spaces).map(([name, paths]) => ({
      name,
      paths,
      description: `Project root: ${paths[0]}`
    }));
  }

  /**
   * Validate embedding dimension matches router
   */
  async validateDimension() {
    const routerDim = await this.router.getEmbeddingDimension?.() || this.config.embeddingDimension;
    if (routerDim !== this.config.embeddingDimension) {
      throw new Error(
        `Embedding dimension mismatch: config=${this.config.embeddingDimension}, router=${routerDim}`
      );
    }
  }

  /**
   * Get storage path for a codebase
   */
  _getCodebasePath(name) {
    return path.join(this.config.dataDir, name);
  }

  /**
   * List all indexed codebases
   */
  async listCodebases() {
    try {
      const entries = await fs.readdir(this.config.dataDir, { withFileTypes: true });
      const codebases = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const metadata = await this._loadCodebaseMetadata(entry.name);
          const analysis = metadata?.llmAnalysis;
          
          codebases.push({
            name: entry.name,
            source: metadata?.source || null,
            files: metadata?.fileCount || 0,
            lastIndexed: metadata?.lastIndexed || null,
            status: metadata?.status || 'unknown',
            description: analysis?.description || null,
            hasAnalysis: !!analysis,
            analysisStale: analysis ? await isAnalysisStale(analysis, metadata.source) : null
          });
        }
      }

      return codebases;
    } catch (err) {
      if (err.code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  /**
   * Load metadata for a codebase
   */
  async _loadCodebaseMetadata(name) {
    try {
      const metadataPath = path.join(this._getCodebasePath(name), 'metadata.json');
      const data = await fs.readFile(metadataPath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Save metadata for a codebase
   */
  async _saveCodebaseMetadata(name, metadata) {
    const codebasePath = this._getCodebasePath(name);
    await fs.mkdir(codebasePath, { recursive: true });
    
    const metadataPath = path.join(codebasePath, 'metadata.json');
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  }

  /**
   * Index a new codebase
   * @param {Object} args
   * @param {string} args.name - Codebase name (e.g., "SoundApp")
   * @param {string} [args.source] - Absolute path to source directory (optional if space provided)
   * @param {string} [args.space] - Space name (e.g., "COOLKID-Work") - resolves project path
   * @param {string} [args.project] - Project folder within space (defaults to name)
   * @param {Function} onProgress - Progress callback
   */
  async indexCodebase(args, onProgress) {
    const { name } = args;
    if (!name) {
      throw new Error('name is required');
    }
    
    // Resolve source path from args
    const source = await this.resolveSourcePath(args);

    // Validate source exists
    const stats = await fs.stat(source).catch(() => null);
    if (!stats?.isDirectory()) {
      throw new Error(`Source directory does not exist: ${source}`);
    }

    const codebasePath = this._getCodebasePath(name);

    // Check if already exists
    try {
      await fs.access(codebasePath);
      // Index exists - check if it's partial/interrupted
      const existingMetadata = await this._loadCodebaseMetadata(name);
      if (existingMetadata?.status === 'indexing' || existingMetadata?.status === 'partial') {
        // Partial index from interrupted run - delete and re-index
        logger.warn(`Detected partial index, rebuilding`, { name }, 'Indexing');
        await this.removeCodebase({ name, permanent: true });
      } else {
        throw new Error(`Codebase '${name}' already indexed. Use refreshCodebase() to update.`);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    // Create directories
    await fs.mkdir(codebasePath, { recursive: true });

    // Initialize nVDB
    const db = new Database(path.join(codebasePath, 'nvdb'));
    const collection = db.createCollection('files', this.config.embeddingDimension, {
      durability: 'buffered'
    });

    // Initialize SQLite metadata
    const metadata = new SimpleMetadataStore(codebasePath);
    await metadata.init();

    // Save source path and config
    await this._saveCodebaseMetadata(name, {
      name,
      source,
      createdAt: new Date().toISOString(),
      lastIndexed: null,
      status: 'indexing',
      embeddingModel: this.config.embeddingModel,
      embeddingDimension: this.config.embeddingDimension
    });

    // Run initial indexing
    const result = await this._runIndexing(name, source, collection, metadata, false, onProgress);

    // Update metadata - use metadata.fileCount for actual total (not just newly indexed)
    await this._saveCodebaseMetadata(name, {
      name,
      source,
      createdAt: new Date().toISOString(),
      lastIndexed: new Date().toISOString(),
      status: result.errors > 0 ? 'partial' : 'current',
      fileCount: metadata.fileCount,
      embeddingModel: this.config.embeddingModel,
      embeddingDimension: this.config.embeddingDimension
    });

    this.indexes.set(name, { db, collection, metadata, source });

    this.analyzeCodebase({ name }).catch(err => {
      logger.warn(`Auto-analysis skipped`, { name, reason: err.message }, 'Indexing');
    });

    return {
      name,
      source,
      indexed: result.indexed,
      errors: result.errors,
      duration: result.duration,
      rate: result.rate,
      errorsDetail: result.errorsDetail
    };
  }

  /**
   * Refresh (incrementally update) a codebase
   * @param {Object} options
   * @param {string} options.name - Codebase name
   */
  async refreshCodebase({ name }, onProgress) {
    const codebase = await this._getCodebase(name);
    const metadataRecord = await this._loadCodebaseMetadata(name);
    
    await this._saveCodebaseMetadata(name, {
      ...metadataRecord,
      status: 'refreshing'
    });

    const result = await this._runIndexing(
      name,
      codebase.source,
      codebase.collection,
      codebase.metadata,
      true, // incremental
      onProgress
    );

    await this._saveCodebaseMetadata(name, {
      ...metadataRecord,
      lastIndexed: new Date().toISOString(),
      status: result.errors > 0 ? 'partial' : 'current',
      fileCount: codebase.metadata.fileCount
    });

    return result;
  }

  /**
   * Copy directory recursively (for Windows EPERM workaround)
   */
  async _copyDir(src, dest) {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        await this._copyDir(srcPath, destPath);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }

  /**
   * Remove a codebase and all its data (moves to trash by default)
   */
  async removeCodebase({ name, permanent = false }) {
    const codebasePath = this._getCodebasePath(name);
    const trashPath = path.join(this.config.trashDir, `${name}_${Date.now()}`);

    // Close if open
    if (this.indexes.has(name)) {
      const { db, metadata } = this.indexes.get(name);
      metadata.close();
      db?.close?.();
      this.indexes.delete(name);
    }

    if (permanent) {
      // Permanent delete
      await fs.rm(codebasePath, { recursive: true, force: true });
      return { name, deleted: true };
    } else {
      // Move to trash - use rm+mkdir workaround for Windows EPERM issues
      await fs.mkdir(this.config.trashDir, { recursive: true });
      try {
        await fs.rename(codebasePath, trashPath);
      } catch (err) {
        if (err.code === 'EPERM') {
          // On Windows, fall back to copy+delete
          await this._copyDir(codebasePath, trashPath);
          await fs.rm(codebasePath, { recursive: true, force: true });
        } else {
          throw err;
        }
      }
      return { name, removed: true, trashPath };
    }
  }

  /**
   * Find codebases matching a partial name (case-insensitive substring match)
   */
  async _findCodebasesByPartialName(partialName) {
    const all = await this.listCodebases();
    const lower = partialName.toLowerCase();
    return all.filter(cb => cb.name.toLowerCase().includes(lower));
  }

  /**
   * Resolve a codebase name - exact match or partial match (returns first/best match)
   */
  async _resolveCodebaseName(name) {
    // Try exact match first
    const exact = await this._loadCodebaseMetadata(name);
    if (exact) return name;

    // Try partial match
    const matches = await this._findCodebasesByPartialName(name);
    if (matches.length >= 1) {
      // Return first match instead of erroring on multiple
      return matches[0].name;
    }
    
    throw new Error(`Codebase '${name}' not found`);
  }

  /**
   * Get or load a codebase
   */
  async _getCodebase(name) {
    // Resolve name (supports partial matching)
    const resolvedName = await this._resolveCodebaseName(name);
    
    // Return cached if available
    if (this.indexes.has(resolvedName)) {
      return this.indexes.get(resolvedName);
    }

    // Load from disk
    const metadata = await this._loadCodebaseMetadata(resolvedName);
    if (!metadata) {
      throw new Error(`Codebase '${resolvedName}' not found`);
    }

    const codebasePath = this._getCodebasePath(resolvedName);
    const db = new Database(path.join(codebasePath, 'nvdb'));
    const collection = db.getCollection('files');
    const metaStore = new SimpleMetadataStore(codebasePath);
    await metaStore.init();

    const codebase = {
      db,
      collection,
      metadata: metaStore,
      source: metadata.source
    };

    this.indexes.set(resolvedName, codebase);
    return codebase;
  }

  /**
   * Run the indexing process
   */
  async _runIndexing(name, source, collection, metadata, incremental = false, onProgress) {
    logger.info(`Starting indexing`, { name, incremental }, 'Indexing');
    const startTime = Date.now();
    
    const result = await this.indexer.indexDirectory({
      source,
      collection,
      metadata,
      incremental,
      onProgress: (progress) => {
        logger.info(progress.message, { name, progress: progress.progress, total: progress.total }, 'Indexing');
        onProgress?.(progress);
      }
    });

    const t0 = Date.now();
    collection.flush();
    const flushTime = Date.now() - t0;
    logger.info(`Indexing complete`, { name, flushTimeMs: flushTime, totalMs: Date.now() - startTime }, 'Indexing');

    return result;
  }

  /**
   * Search by keyword (path + content)
   */
  async searchKeyword({ codebase, query, limit = 20, searchContent = true, filter }) {
    const { metadata, source } = await this._getCodebase(codebase);
    
    logger.info(`Keyword search`, { codebase, query, limit, searchContent }, 'Search');
    
    let pathResults = await metadata.searchKeyword(query, limit * 2);
    logger.debug(`Path results`, { count: pathResults.length }, 'Search');
    
    let contentResults = [];
    if (searchContent) {
      try {
        contentResults = await this.grepSearcher.grep(source, query, {
          regex: false,
          limit: limit * 2,
          maxMatchesPerFile: 1,
          caseSensitive: false,
          excludeExtensions: [...BINARY_EXTENSIONS]
        });
        logger.debug(`Content results`, { count: contentResults.length }, 'Search');
      } catch (err) {
        logger.error(`Grep error for query "${query}"`, err, { query, sourcePath: source }, 'Search');
        const sourceExists = await fs.access(source).then(() => true).catch(() => false);
        logger.error(`Source path check`, { path: source, exists: sourceExists }, 'Search');
      }
    }
    
    const seen = new Set();
    const merged = [];
    
    for (const r of pathResults) {
      if (!seen.has(r.path)) {
        seen.add(r.path);
        merged.push({ path: r.path, rank: r.rank, contentMatches: null });
      }
    }
    
    for (const r of contentResults) {
      if (!seen.has(r.path)) {
        seen.add(r.path);
        merged.push({ path: r.path, rank: -0.3, contentMatches: { line: r.line, content: r.content } });
      } else {
        const existing = merged.find(m => m.path === r.path);
        if (existing && !existing.contentMatches) {
          existing.contentMatches = { line: r.line, content: r.content };
        }
      }
    }
    
    let results = merged;
    if (filter?.excludeExtensions || filter?.includeExtensions) {
      results = results.filter(r => _matchesExtension(r.path, filter));
    }
    
    if (results.length === 0 && searchContent && contentResults.length === 0) {
      logger.debug(`No results, trying fallback grep with regex mode`, { query }, 'Search');
      try {
        const fallbackResults = await this.grepSearcher.grep(source, query, {
          regex: true,
          limit: limit * 2,
          maxMatchesPerFile: 1,
          caseSensitive: false,
          excludeExtensions: [...BINARY_EXTENSIONS]
        });
        logger.debug(`Fallback results`, { count: fallbackResults.length }, 'Search');
        for (const r of fallbackResults) {
          if (!seen.has(r.path)) {
            seen.add(r.path);
            results.push({ path: r.path, rank: -0.3, contentMatches: { line: r.line, content: r.content } });
          }
        }
      } catch (err) {
        logger.error(`Fallback grep failed`, err, { query }, 'Search');
      }
    }
    
    results = results.slice(0, limit);
    logger.info(`Search complete`, { codebase, query, resultCount: results.length }, 'Search');
    
    return {
      results: results.map(r => ({
        file: `${codebase}:${r.path}`,
        path: r.path,
        rank: r.rank,
        contentMatches: r.contentMatches || null
      })),
      count: results.length
    };
  }

  /**
   * Live grep search
   */
  async grepCodebase({ 
    codebase, 
    pattern, 
    regex = true, 
    limit = 50, 
    maxMatchesPerFile = 5,
    caseSensitive = false,
    pathPattern = null,
    noCache = false,
    excludeExtensions = null
  }) {
    const { source } = await this._getCodebase(codebase);
    
    const results = await this.grepSearcher.grep(source, pattern, { 
      regex, 
      limit, 
      maxMatchesPerFile,
      caseSensitive,
      pathPattern,
      noCache,
      excludeExtensions: excludeExtensions || [...BINARY_EXTENSIONS]
    });
    
    return {
      results: results.map(r => ({
        file: `${codebase}:${r.path}`,
        ...r
      })),
      count: results.length
    };
  }

  /**
   * Hybrid search - combines semantic + keyword + optional grep
   */
  async search({ codebase, query, strategy = 'hybrid', limit = 10, filter }) {
    const { collection, metadata, source } = await this._getCodebase(codebase);
    
    // Gather results based on strategy
    const semanticResults = [];
    const keywordResults = [];
    let grepResults = [];
    let embeddingFailed = false;
    
    // Always do semantic for 'hybrid' and 'semantic' strategies
    if (strategy === 'hybrid' || strategy === 'semantic') {
      try {
        const queryEmbedding = await this.router.embedText(query);
        const rawResults = collection.search({
          vector: queryEmbedding,
          top_k: limit * 3,
          approximate: true,
          ef: 64
        });
        
        for (const match of rawResults) {
          const fileInfo = await metadata.getFile(match.id);
          if (fileInfo) {
            semanticResults.push({
              path: match.id,
              score: match.score,
              language: fileInfo.language,
              functions: fileInfo.functions || [],
              classes: fileInfo.classes || []
            });
          }
        }
      } catch (err) {
        embeddingFailed = true;
        logger.warn(`Embedding unavailable for search, falling back to keyword-only`, { 
          codebase, 
          query, 
          error: err.message 
        }, 'Search');
        // For hybrid: continue with empty semantic results (keyword will still work)
        // For semantic: will return empty results (handled below)
      }
    }
    
    if (strategy === 'hybrid' || strategy === 'keyword') {
      const pathResults = await metadata.searchKeyword(query, limit * 2);
      keywordResults.push(...pathResults.map(r => ({ path: r.path, rank: r.rank, source: 'path' })));

      try {
        const tokens = query.split(/[\s._-]+/).filter(t => t.length >= 2);
        const searchTerms = tokens.length > 0 ? tokens : [query];
        const contentResults = await this.grepSearcher.grep(source, searchTerms.join('|'), {
          regex: true,
          limit: limit * 3,
          maxMatchesPerFile: 1,
          caseSensitive: false,
          excludeExtensions: [...BINARY_EXTENSIONS]
        });
        const existingPaths = new Set(keywordResults.map(r => r.path));
        for (const g of contentResults) {
          if (!existingPaths.has(g.path)) {
            keywordResults.push({ path: g.path, rank: -0.3, source: 'content', match: g.content?.slice(0, 200) });
            existingPaths.add(g.path);
          }
        }
      } catch {}
    }
    
    // Combine results
    let combined;
    if (strategy === 'hybrid') {
      combined = this.searchRouter.combineResults(semanticResults, keywordResults);
    } else if (strategy === 'semantic') {
      combined = semanticResults;
    } else if (strategy === 'keyword') {
      combined = keywordResults.map(r => ({ 
        path: r.path, 
        score: 1 / (1 + Math.abs(r.rank))  // Convert rank to score
      }));
    }
    
    // Apply filters
    if (filter?.language) {
      const filterLang = filter.language.toLowerCase();
      combined = combined.filter(r => 
        (r.language && r.language.toLowerCase() === filterLang) || !r.language
      );
    }
    if (filter?.excludeExtensions || filter?.includeExtensions) {
      combined = combined.filter(r => _matchesExtension(r.path, filter));
    }
    
    // Limit results
    combined = combined.slice(0, limit);
    
    // Enrich with full file info
    const enriched = [];
    for (const item of combined) {
      const fileInfo = await metadata.getFile(item.path);
      if (fileInfo) {
        enriched.push({
          file: `${codebase}:${item.path}`,
          path: item.path,
          score: item.score,
          semanticScore: item.semanticScore,
          keywordScore: item.keywordScore,
          language: fileInfo.language,
          functions: fileInfo.functions || [],
          classes: fileInfo.classes || []
        });
      }
    }
    
    const result = {
      results: enriched,
      count: enriched.length,
      strategy
    };
    
    if (embeddingFailed) {
      result.warning = 'Embedding service unavailable. Results are keyword-only.';
    }
    
    return result;
  }

  /**
   * Search for semantically similar code
   */
  async searchSemantic({ codebase, query, limit = 10, filter }) {
    const { collection, metadata } = await this._getCodebase(codebase);

    // Generate query embedding
    let queryEmbedding;
    try {
      queryEmbedding = await this.router.embedText(query);
    } catch (err) {
      logger.warn(`Embedding unavailable for semantic search`, { 
        codebase, 
        query, 
        error: err.message 
      }, 'Search');
      return { 
        results: [], 
        count: 0, 
        warning: 'Embedding service unavailable. Try keyword search instead.' 
      };
    }

    // Search nVDB
    const results = collection.search({
      vector: queryEmbedding,
      top_k: limit * 2, // Fetch extra for post-filtering
      approximate: true,
      ef: 64
    });
    
    logger.info(`Semantic search raw results`, { 
      codebase, 
      query, 
      rawCount: results.length,
      topScore: results[0]?.score 
    }, 'Search');

    // Apply post-filtering and enrich results
    const enriched = [];
    for (const match of results) {
      if (enriched.length >= limit) break;

      const fileInfo = await metadata.getFile(match.id);
      if (!fileInfo) {
        logger.debug(`No metadata for match`, { path: match.id }, 'Search');
        continue;
      }

      // Apply filters
      if (filter?.language && fileInfo.language?.toLowerCase() !== filter.language.toLowerCase()) continue;
      if (filter?.excludeExtensions || filter?.includeExtensions) {
        if (!_matchesExtension(match.id, filter)) continue;
      }

      enriched.push({
        file: `${codebase}:${match.id}`,
        score: match.score,
        path: match.id,
        language: fileInfo.language,
        functions: fileInfo.functions || [],
        classes: fileInfo.classes || []
      });
    }

    return { results: enriched, count: enriched.length };
  }

  /**
   * Search across ALL codebases - optimized with parallel processing
   */
  async searchAll({ query, strategy = 'hybrid', limit = 10, filter, perCodebaseLimit = 5, concurrency = 10 }) {
    const startTime = Date.now();
    const allCodebases = await this.listCodebases();
    
    // Filter out empty codebases (0 files) - these can't have results
    const validCodebases = allCodebases.filter(cb => cb.files > 0);
    
    const allResults = [];
    const errors = [];
    let resultsFound = 0;
    
    // Helper to search a single codebase
    const searchOne = async (cb) => {
      // Early termination check
      if (resultsFound >= limit) return null;
      
      try {
        const searchLimit = Math.min(perCodebaseLimit, limit);
        let results;
        
        if (strategy === 'grep') {
          results = await this.grepCodebase({ 
            codebase: cb.name, 
            pattern: query, 
            regex: true, 
            limit: searchLimit 
          });
        } else if (strategy === 'keyword') {
          results = await this.searchKeyword({ 
            codebase: cb.name, 
            query, 
            limit: searchLimit,
            filter 
          });
        } else if (strategy === 'semantic') {
          results = await this.searchSemantic({ 
            codebase: cb.name, 
            query, 
            limit: searchLimit,
            filter 
          });
        } else {
          // hybrid
          results = await this.search({ 
            codebase: cb.name, 
            query, 
            strategy: 'hybrid', 
            limit: searchLimit,
            filter 
          });
        }
        
        if (results.results && results.results.length > 0) {
          resultsFound += results.results.length;
          return {
            codebase: cb.name,
            count: results.count,
            results: results.results.map(r => ({ ...r, codebase: cb.name }))
          };
        }
      } catch (err) {
        errors.push({ codebase: cb.name, error: err.message });
      }
      return null;
    };
    
    // Process in batches for concurrency control
    for (let i = 0; i < validCodebases.length; i += concurrency) {
      // Early termination if we have enough results
      if (resultsFound >= limit) break;
      
      const batch = validCodebases.slice(i, i + concurrency);
      const batchResults = await Promise.all(batch.map(searchOne));
      
      for (const result of batchResults) {
        if (result) allResults.push(result);
      }
    }
    
    // Flatten and sort by score (for semantic/hybrid) or keep grouped
    const flattened = [];
    for (const cbResult of allResults) {
      flattened.push(...cbResult.results);
    }
    
    // Sort by score (descending) if available
    if (strategy !== 'grep' && strategy !== 'keyword') {
      flattened.sort((a, b) => (b.score || 0) - (a.score || 0));
    }
    
    // Apply global limit
    const limited = flattened.slice(0, limit);
    
    const duration = Date.now() - startTime;
    
    return {
      results: limited,
      totalCount: flattened.length,
      codebasesSearched: validCodebases.length,
      codebasesWithResults: allResults.length,
      strategy,
      durationMs: duration,
      errors: errors.length > 0 ? errors : undefined
    };
  }



  /**
   * Get file tree for a codebase
   */
  async getFileTree({ codebase, path: subpath = '' }) {
    const { metadata } = await this._getCodebase(codebase);
    return metadata.getFileTree(subpath);
  }

  /**
   * Get file info (functions, classes, etc.)
   */
  async getFileInfo({ codebase, path: filePath }) {
    const { collection, metadata } = await this._getCodebase(codebase);
    const info = await metadata.getFile(filePath);
    
    if (!info) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Get symbols from nVDB payload
    let symbols = { functions: [], classes: [], imports: [] };
    try {
      // nVDB stores payload as JSON string - retrieve it via collection.get
      const doc = collection.get(filePath);
      if (doc && doc.payload) {
        const payload = JSON.parse(doc.payload);
        symbols.functions = payload.functions || [];
        symbols.classes = payload.classes || [];
        symbols.imports = payload.imports || [];
      }
    } catch {
      // If get() fails or payload is missing, return empty symbols
    }

    return {
      file: `${codebase}:${filePath}`,
      ...info,
      functions: symbols.functions,
      classes: symbols.classes,
      imports: symbols.imports
    };
  }

  /**
   * Get file content with staleness check
   */
  async getFile({ codebase, path: filePath }) {
    const { source, metadata } = await this._getCodebase(codebase);
    const info = await metadata.getFile(filePath);

    if (!info) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Read current file
    const fullPath = path.join(source, filePath);
    const content = await fs.readFile(fullPath, 'utf-8').catch(() => null);

    if (content === null) {
      throw new Error(`File not readable: ${filePath}`);
    }

    // Check staleness
    const stats = await fs.stat(fullPath);
    const stale = stats.mtimeMs > info.mtime;

    return {
      content,
      stale,
      lastIndexed: info.lastIndexed
    };
  }

  // ========== Maintenance Operations ==========

  /**
   * Check staleness status of a codebase
   */
  async checkCodebaseStatus({ codebase }) {
    return this.maintenance.getStalenessReport(codebase);
  }

  /**
   * Check if a specific file is stale
   */
  async checkFileStale({ codebase, path: filePath }) {
    return this.maintenance.isFileStale(codebase, filePath);
  }

  /**
   * Run maintenance cycle with configurable options
   *
   * @param {Object} options
   * @param {string} options.codebase - Specific codebase to maintain (omit for all)
   * @param {string} options.reindex - Reindex mode: "if_missing", "changed", "always", null
   */
  async runMaintenance({ codebase, reindex } = {}) {
    if (codebase) {
      return this._runMaintenanceOnCodebase(codebase, reindex);
    } else {
      const configCodebases = await this._getAllConfiguredCodebases();
      const indexedCodebases = await this.listCodebases();
      const indexedNames = new Set(indexedCodebases.map(cb => cb.name));
      const results = [];

      for (const cb of indexedCodebases) {
        if (!configCodebases.has(cb.name)) {
          const result = await this._runMaintenanceOnCodebase(cb.name, reindex);
          results.push(result);
        }
      }

      for (const name of configCodebases) {
        const result = await this._runMaintenanceOnCodebase(name, reindex);
        results.push(result);
      }

      return {
        message: 'Maintenance cycle complete',
        codebasesProcessed: results.length,
        results
      };
    }
  }

  /**
   * Get all codebase names from config
   */
  async _getAllConfiguredCodebases() {
    try {
      const configPath = path.join(process.cwd(), 'data', 'codebases.json');
      const raw = await fs.readFile(configPath, 'utf8');
      const codebasesConfig = JSON.parse(raw);
      return new Set(Object.keys(codebasesConfig.codebases || {}));
    } catch {
      return new Set();
    }
  }

  /**
   * Run maintenance on a single codebase
   */
  async _runMaintenanceOnCodebase(codebaseName, reindexMode) {
    const codebases = await this.listCodebases();
    const indexedCodebase = codebases.find(cb => cb.name === codebaseName);
    const exists = !!indexedCodebase;

    const configSource = await this._getCodebaseSourcePath(codebaseName);
    const orphaned = exists && !configSource;

    if (orphaned) {
      const result = await this.removeCodebase({ name: codebaseName });
      return { codebase: codebaseName, action: 'orphaned_removed', ...result };
    }

    if (!exists) {
      if (reindexMode === 'if_missing' || reindexMode === 'always' || reindexMode === true) {
        if (!configSource) {
          return { codebase: codebaseName, error: 'Codebase not found in configuration' };
        }
        const result = await this.indexCodebase({ name: codebaseName, source: configSource });
        return { codebase: codebaseName, action: 'indexed', ...result };
      } else {
        return { codebase: codebaseName, error: 'Codebase not indexed. Use reindex:"if_missing" to build.' };
      }
    }

    if (reindexMode === 'always') {
      const result = await this.refreshCodebase({ name: codebaseName });
      return { codebase: codebaseName, action: 'rebuilt', ...result };
    }

    const changeResult = await this.maintenance.checkAndRefresh(codebaseName);

    return { codebase: codebaseName, action: changeResult.reason, ...changeResult };
  }

  /**
   * Get source path for a codebase from codebases.json
   */
  async _getCodebaseSourcePath(codebaseName) {
    try {
      const configPath = path.join(process.cwd(), 'data', 'codebases.json');
      const raw = await fs.readFile(configPath, 'utf8');
      const codebasesConfig = JSON.parse(raw);
      return codebasesConfig.codebases?.[codebaseName] || null;
    } catch {
      return null;
    }
  }

  /**
   * Get maintenance statistics
   */
  async getMaintenanceStats() {
    return this.maintenance.getStats();
  }

  // ========== LLM Project Analysis ==========

  /**
   * Analyze a codebase using metadata heuristics to generate description and identify key files
   */
  async analyzeCodebase({ name }, onProgress) {
    const codebase = await this._getCodebase(name);
    const metadataRecord = await this._loadCodebaseMetadata(name);
    
    if (!metadataRecord) {
      throw new Error(`Codebase '${name}' not found`);
    }

    onProgress?.({ phase: 'analyzing', message: 'Running heuristic analysis...' });

    const analysis = await analyzeProject(
      this.router, // pass the LLM router down!
      codebase.metadata,
      codebase.source,
      onProgress
    );

    await this._saveCodebaseMetadata(name, {
      ...metadataRecord,
      llmAnalysis: analysis
    });

    return {
      name,
      analyzed: true,
      description: analysis.description,
      duration: analysis.duration,
      filesAnalyzed: analysis.filesAnalyzed
    };
  }

  /**
   * Get codebase description with staleness check
   */
  async getCodebaseDescription({ name }) {
    const metadata = await this._loadCodebaseMetadata(name);
    
    if (!metadata) {
      throw new Error(`Codebase '${name}' not found`);
    }

    const analysis = metadata.llmAnalysis;
    
    if (!analysis) {
      return {
        name,
        hasAnalysis: false,
        message: 'No analysis available. Run analyze_codebase first.'
      };
    }

    // Check staleness
    const stale = await isAnalysisStale(analysis, metadata.source);

    return {
      name,
      hasAnalysis: true,
      stale,
      description: analysis.description,
      purpose: analysis.purpose,
      insights: analysis.insights,
      keyFiles: analysis.keyFiles,
      entryPoints: analysis.entryPoints,
      analyzedAt: analysis.analyzedAt,
      model: analysis.model,
      duration: analysis.duration
    };
  }

  /**
   * Get prioritized file list for search
   */
  async getPrioritizedFiles({ name, asTree = true, filter }) {
    const codebase = await this._getCodebase(name);
    const metadata = await this._loadCodebaseMetadata(name);
    
    let allFiles = (await codebase.metadata.getAllFiles()).map(f => f.path);

    if (filter?.excludeExtensions || filter?.includeExtensions) {
      allFiles = allFiles.filter(f => _matchesExtension(f, filter));
    }

    if (asTree) {
      // Build a simple tree string to return to LLM
      const treeObj = {};
      for (const p of allFiles) {
        const parts = p.split('/');
        let current = treeObj;
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          if (!current[part]) current[part] = (i === parts.length - 1) ? null : {};
          current = current[part];
        }
      }

      const stringifyTree = (node, indent = '') => {
        let lines = [];
        for (const [key, val] of Object.entries(node)) {
          if (val === null) {
            lines.push(`${indent}📄 ${key}`);
          } else {
            lines.push(`${indent}📁 ${key}/`);
            lines.push(...stringifyTree(val, indent + '  '));
          }
        }
        return lines;
      };

      const treeString = stringifyTree(treeObj).join('\n');
      return {
        name,
        totalFiles: allFiles.length,
        tree: treeString,
        prioritized: { high: [], medium: [], low: allFiles } // Keep legacy structure just in case existing clients expect it
      };
    }

    const prioritized = getPrioritizedFiles(metadata?.llmAnalysis, allFiles);
    
    return {
      name,
      prioritized,
      totalFiles: allFiles.length
    };
  }

  // ========== MCP Tool Integration ==========

  getTools() {
    return [
      {
        name: 'list_codebases',
        description: 'List all indexed codebases with status and file counts',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'list_spaces',
        description: 'List available spaces (configured project roots) for indexing codebases. Use this to find space names before calling index_codebase.',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'index_codebase',
        description: 'Index a new codebase for semantic search. Provide either "source" (absolute path) OR "space" (configured space name).',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Codebase name (e.g., "SoundApp")' },
            source: { type: 'string', description: 'Absolute path to source directory (alternative to space)' },
            space: { type: 'string', description: 'Space name from config (e.g., "COOLKID-Work") - resolves project path automatically' },
            project: { type: 'string', description: 'Project folder name within space (defaults to codebase name if not specified)' }
          },
          required: ['name']
        }
      },
      {
        name: 'search_codebase',
        description: 'Primary search tool for single codebase. RECOMMENDED over grep_codebase for most searches. Combines semantic (meaning) + keyword (exact) matching. Use strategy:keyword for fast name lookups, strategy:semantic for concept queries. Codebase name supports partial matching.',
        inputSchema: {
          type: 'object',
          properties: {
            codebase: { type: 'string', description: 'Codebase name (partial match supported)' },
            query: { type: 'string', description: 'Search query (natural language or keywords)' },
            strategy: { type: 'string', enum: ['hybrid', 'semantic', 'keyword'], default: 'hybrid', description: 'hybrid=best overall, keyword=fast exact match, semantic=conceptual similarity' },
            limit: { type: 'number', default: 10 },
            filter: { 
              type: 'object',
              properties: {
                language: { type: 'string' },
                excludeExtensions: { type: 'array', items: { type: 'string' }, description: 'File extensions to exclude, e.g. [".png", ".svg"]' },
                includeExtensions: { type: 'array', items: { type: 'string' }, description: 'Only include these extensions, e.g. [".js", ".ts"]' }
              }
            }
          },
          required: ['codebase', 'query']
        }
      },
      {
        name: 'search_semantic',
        description: 'Semantic (AI embedding) search - finds conceptually similar code. Best for: "how is X implemented?", "find code that does Y", pattern discovery. Slower than keyword but understands meaning, not just text. Codebase name supports partial matching.',
        inputSchema: {
          type: 'object',
          properties: {
            codebase: { type: 'string', description: 'Codebase name (partial match supported)' },
            query: { type: 'string', description: 'Natural language query describing what you are looking for' },
            limit: { type: 'number', default: 10 },
            filter: { 
              type: 'object',
              properties: {
                language: { type: 'string' },
                excludeExtensions: { type: 'array', items: { type: 'string' }, description: 'File extensions to exclude, e.g. [".png", ".svg"]' },
                includeExtensions: { type: 'array', items: { type: 'string' }, description: 'Only include these extensions, e.g. [".js", ".ts"]' }
              }
            }
          },
          required: ['codebase', 'query']
        }
      },
      {
        name: 'search_keyword',
        description: 'FAST indexed keyword search. Best for: exact function names, class names, variable names, imports. Searches file paths AND content. Much faster than grep_codebase (<100ms vs 1-3s). Use this INSTEAD of grep_codebase when searching for specific identifiers. Codebase name supports partial matching.',
        inputSchema: {
          type: 'object',
          properties: {
            codebase: { type: 'string', description: 'Codebase name (partial match supported)' },
            query: { type: 'string', description: 'Keywords to search (function names, class names, etc.)' },
            limit: { type: 'number', default: 20 },
            searchContent: { type: 'boolean', default: true, description: 'Search file content (not just paths). Slightly slower but more thorough.' },
            filter: { 
              type: 'object',
              properties: {
                excludeExtensions: { type: 'array', items: { type: 'string' }, description: 'File extensions to exclude, e.g. [".png", ".svg"]' },
                includeExtensions: { type: 'array', items: { type: 'string' }, description: 'Only include these extensions, e.g. [".js", ".ts"]' }
              }
            }
          },
          required: ['codebase', 'query']
        }
      },
      {
        name: 'grep_codebase',
        description: 'Live regex search using ripgrep. ALWAYS CURRENT (searches filesystem directly). Use ONLY when: (1) You need regex patterns, (2) You need exact line numbers for editing, (3) You suspect index is stale. OTHERWISE prefer search_keyword (faster for names) or search_semantic (for concepts). Codebase name supports partial matching.',
        inputSchema: {
          type: 'object',
          properties: {
            codebase: { type: 'string', description: 'Codebase name (partial match supported)' },
            pattern: { type: 'string', description: 'Search pattern (regex or literal string)' },
            regex: { type: 'boolean', default: true, description: 'Use regex pattern matching. Set to false for literal string search (faster)' },
            limit: { type: 'number', default: 50, description: 'Max total results to return' },
            maxMatchesPerFile: { type: 'number', default: 5, description: 'Max matches per file (-1 for unlimited, 1 for "find files only")' },
            caseSensitive: { type: 'boolean', default: false, description: 'Case-sensitive search' },
            pathPattern: { type: 'string', description: 'Filter by file path glob (e.g., "*.js", "src/**")' },
            noCache: { type: 'boolean', default: false, description: 'Skip cache and force fresh search' },
            excludeExtensions: { type: 'array', items: { type: 'string' }, description: 'File extensions to exclude, e.g. [".png", ".svg"]. Binary files auto-excluded by default.' }
          },
          required: ['codebase', 'pattern']
        }
      },
      {
        name: 'search_all_codebases',
        description: 'Search across ALL indexed codebases at once. Strategies: hybrid (default, best overall), semantic (conceptual), keyword (fast exact match). AVOID strategy:grep unless you need regex - it is 10x slower. Codebase name supports partial matching.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query (natural language, keywords, or grep pattern)' },
            strategy: { type: 'string', enum: ['hybrid', 'semantic', 'keyword', 'grep'], default: 'hybrid', description: 'hybrid=best overall (default), keyword=fastest, semantic=conceptual, grep=slow regex (avoid unless needed)' },
            limit: { type: 'number', default: 20, description: 'Total result limit across all codebases' },
            perCodebaseLimit: { type: 'number', default: 5, description: 'Max results per codebase' },
            concurrency: { type: 'number', default: 10, description: 'Number of codebases to search in parallel' },
            filter: { 
              type: 'object',
              properties: {
                language: { type: 'string' },
                excludeExtensions: { type: 'array', items: { type: 'string' }, description: 'File extensions to exclude, e.g. [".png", ".svg"]' },
                includeExtensions: { type: 'array', items: { type: 'string' }, description: 'Only include these extensions, e.g. [".js", ".ts"]' }
              }
            }
          },
          required: ['query']
        }
      },
      {
        name: 'get_file_tree',
        description: 'Get a clean, hierarchical file tree of the codebase or a specific directory. Useful for understanding project structure directly. Codebase name supports partial matching.',
        inputSchema: {
          type: 'object',
          properties: {
            codebase: { type: 'string', description: 'Codebase name (partial match supported)' },
            path: { type: 'string', description: 'Optional subpath to get tree for a specific directory (default: root)' }
          },
          required: ['codebase']
        }
      },
      {
        name: 'get_file_info',
        description: 'Get file structure (functions, classes, imports) without content. Codebase name supports partial matching.',
        inputSchema: {
          type: 'object',
          properties: {
            codebase: { type: 'string', description: 'Codebase name (partial match supported)' },
            path: { type: 'string' }
          },
          required: ['codebase', 'path']
        }
      },
      {
        name: 'get_file',
        description: 'Get file content with staleness check. Codebase name supports partial matching.',
        inputSchema: {
          type: 'object',
          properties: {
            codebase: { type: 'string', description: 'Codebase name (partial match supported)' },
            path: { type: 'string' }
          },
          required: ['codebase', 'path']
        }
      },
      {
        name: 'refresh_codebase',
        description: 'Incremental refresh of codebase index',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' }
          },
          required: ['name']
        }
      },
      {
        name: 'remove_codebase',
        description: 'Remove a codebase and all its data',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' }
          },
          required: ['name']
        }
      },
      {
        name: 'check_codebase_status',
        description: 'Check staleness status of a codebase (stale files, missing files). Codebase name supports partial matching.',
        inputSchema: {
          type: 'object',
          properties: {
            codebase: { type: 'string', description: 'Codebase name (partial match supported)' }
          },
          required: ['codebase']
        }
      },
      {
        name: 'check_file_stale',
        description: 'Check if a specific file is stale (changed since indexing). Codebase name supports partial matching.',
        inputSchema: {
          type: 'object',
          properties: {
            codebase: { type: 'string', description: 'Codebase name (partial match supported)' },
            path: { type: 'string', description: 'File path relative to codebase root' }
          },
          required: ['codebase', 'path']
        }
      },
      {
        name: 'run_maintenance',
        description: 'Manually trigger maintenance cycle to refresh stale codebases',
        inputSchema: {
          type: 'object',
          properties: {
            codebase: { type: 'string', description: 'Specific codebase to refresh, or omit for all' },
            reindex: { type: 'string', description: 'Reindex mode: "if_missing" (build if not exists), "changed" (update existing), "always" (rebuild)' }
          }
        }
      },
      {
        name: 'get_maintenance_stats',
        description: 'Get maintenance statistics and status',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'analyze_codebase',
        description: 'Run heuristic analysis to generate project description and identify key files. No LLM required - uses metadata patterns. Codebase name supports partial matching.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Codebase name to analyze (partial match supported)' }
          },
          required: ['name']
        }
      },
      {
        name: 'get_codebase_description',
        description: 'Get project description with staleness check. Codebase name supports partial matching.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Codebase name (partial match supported)' }
          },
          required: ['name']
        }
      },
      {
        name: 'get_prioritized_files',
        description: 'Get files ordered by importance (high/medium/low priority) OR raw file tree. Useful for getting a holistic structural view of the project. Codebase name supports partial matching.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Codebase name (partial match supported)' },
            asTree: { type: 'boolean', default: true, description: 'Return a visual directory tree string instead of a partitioned JSON list' },
            filter: {
              type: 'object',
              properties: {
                excludeExtensions: { type: 'array', items: { type: 'string' }, description: 'File extensions to exclude, e.g. [".png", ".svg"]' },
                includeExtensions: { type: 'array', items: { type: 'string' }, description: 'Only include these extensions, e.g. [".js", ".ts"]' }
              }
            }
          },
          required: ['name']
        }
      }
    ];
  }

  handlesTool(name) {
    return [
      'list_codebases',
      'list_spaces',
      'index_codebase',
      'refresh_codebase',
      'remove_codebase',
      'search_codebase',
      'search_semantic',
      'search_keyword',
      'grep_codebase',
      'search_all_codebases',
      'get_file_tree',
      'get_file_info',
      'get_file',
      'check_codebase_status',
      'check_file_stale',
      'run_maintenance',
      'get_maintenance_stats',
      'analyze_codebase',
      'get_codebase_description',
      'get_prioritized_files'
    ].includes(name);
  }

  async callTool(name, args) {
    // Map tool names to method names
    const methodMap = {
      'list_codebases': 'listCodebases',
      'list_spaces': 'listSpaces',
      'index_codebase': 'indexCodebase',
      'refresh_codebase': 'refreshCodebase',
      'remove_codebase': 'removeCodebase',
      'search_codebase': 'search',
      'search_semantic': 'searchSemantic',
      'search_keyword': 'searchKeyword',
      'grep_codebase': 'grepCodebase',
      'search_all_codebases': 'searchAll',
      'get_file_tree': 'getFileTree',
      'get_file_info': 'getFileInfo',
      'get_file': 'getFile',
      'check_codebase_status': 'checkCodebaseStatus',
      'check_file_stale': 'checkFileStale',
      'run_maintenance': 'runMaintenance',
      'get_maintenance_stats': 'getMaintenanceStats',
      'analyze_codebase': 'analyzeCodebase',
      'get_codebase_description': 'getCodebaseDescription',
      'get_prioritized_files': 'getPrioritizedFiles'
    };
    
    const methodName = methodMap[name];
    if (!methodName || typeof this[methodName] !== 'function') {
      throw new Error(`Unknown tool: ${name}`);
    }
    
    const result = await this[methodName](args);
    
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
}
// --- Agent Contract ---

let serviceInstance = null;

export async function init(context) {
    serviceInstance = new CodebaseIndexingService({ ...context.config.codebase, spaces: context.config.spaces }, context.gateway);
    serviceInstance.setProgressCallback((cb) => {
        serviceInstance.progressCallback = cb ? (data) => context.progress(data.message, data.progress, data.total) : null;
    });
    // Try to preload but don't crash on failure
    serviceInstance.preloadAll().catch(err => {
      logger.error('Preload failed', err, {}, 'CodebaseIndexing');
    });
    // Start periodic maintenance cycle
    serviceInstance.startMaintenance();
    return serviceInstance;
}

export async function shutdown() {
    if (serviceInstance) {
        if (serviceInstance.stopMaintenance) serviceInstance.stopMaintenance();
        serviceInstance.maintenance.stop();
    }
    logger.info('Indexing service shutdown', {}, 'CodebaseIndexing');
}

// Tool handlers
export async function list_codebases(args, context) { return serviceInstance.callTool('list_codebases', args); }
export async function list_spaces(args, context) { return serviceInstance.callTool('list_spaces', args); }
export async function index_codebase(args, context) { return serviceInstance.callTool('index_codebase', args); }
export async function search_codebase(args, context) { return serviceInstance.callTool('search_codebase', args); }
export async function search_semantic(args, context) { return serviceInstance.callTool('search_semantic', args); }
export async function search_keyword(args, context) { return serviceInstance.callTool('search_keyword', args); }
export async function grep_codebase(args, context) { return serviceInstance.callTool('grep_codebase', args); }
export async function search_all_codebases(args, context) { return serviceInstance.callTool('search_all_codebases', args); }
export async function get_file_info(args, context) { return serviceInstance.callTool('get_file_info', args); }
export async function get_file(args, context) { return serviceInstance.callTool('get_file', args); }
export async function refresh_codebase(args, context) { return serviceInstance.callTool('refresh_codebase', args); }
export async function remove_codebase(args, context) { return serviceInstance.callTool('remove_codebase', args); }
export async function check_codebase_status(args, context) { return serviceInstance.callTool('check_codebase_status', args); }
export async function check_file_stale(args, context) { return serviceInstance.callTool('check_file_stale', args); }
export async function run_maintenance(args, context) { return serviceInstance.callTool('run_maintenance', args); }
export async function get_maintenance_stats(args, context) { return serviceInstance.callTool('get_maintenance_stats', args); }
export async function analyze_codebase(args, context) { return serviceInstance.callTool('analyze_codebase', args); }
export async function get_codebase_description(args, context) { return serviceInstance.callTool('get_codebase_description', args); }
export async function get_prioritized_files(args, context) { return serviceInstance.callTool('get_prioritized_files', args); }
