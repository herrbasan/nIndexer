/**
 * Codebase Maintenance - Automatic index refresh and staleness detection
 * 
 * Features:
 * - Periodic refresh of indexed codebases
 * - Staleness detection (file mtime changes)
 * - Incremental updates (only changed files)
 * - Configurable intervals per codebase
 */

import fs from 'fs/promises';
import path from 'path';
import { getLogger } from '../utils/logger.js';

const logger = getLogger();

export class CodebaseMaintenance {
  constructor(service, config = {}) {
    this.service = service;
    this.discoveryService = null;
    this.config = {
      enabled: true,
      intervalMs: 900000,
      autoRefresh: true,
      staleThresholdMs: 300000,
      ...config
    };
    this.intervalId = null;
    this.isRunning = false;
    this.lastRun = null;
    this.stats = {
      totalRefreshes: 0,
      filesUpdated: 0,
      errors: 0
    };
  }

  setDiscoveryService(discoveryService) {
    this.discoveryService = discoveryService;
  }

  /**
   * Start automatic maintenance cycle
   */
  start() {
    if (!this.config.enabled || this.intervalId) return;
    
    this.intervalId = setInterval(
      () => this.runMaintenance(),
      this.config.intervalMs
    );
    
    logger.info(`Maintenance started`, { intervalMin: this.config.intervalMs / 60000 }, 'Maintenance');
  }

  /**
   * Stop maintenance cycle
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info(`Maintenance stopped`, {}, 'Maintenance');
    }
  }

  /**
   * Run maintenance cycle - refresh all codebases and index new ones
   */
  async runMaintenance() {
    if (this.isRunning) {
      logger.warn(`Maintenance skipped - previous run still active`, {}, 'Maintenance');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    
    try {
      // Re-run discovery to pick up new/removed folders
      if (this.discoveryService) {
        try {
          await this.discoveryService.scanAndSync();
        } catch (err) {
          logger.error(`Discovery during maintenance failed`, err, {}, 'Maintenance');
        }
      }

      const t0 = Date.now();
      const codebases = await this.service.listCodebases();
      logger.debug(`List codebases`, { durationMs: Date.now() - t0, count: codebases.length }, 'Maintenance');

      // Refresh already-indexed codebases
      for (const cb of codebases) {
        if (cb.status === 'indexing') {
          logger.debug(`Skipping codebase`, { name: cb.name, reason: 'currently indexing' }, 'Maintenance');
          continue;
        }

        try {
          const cbStart = Date.now();
          const result = await this.checkAndRefresh(cb.name);
          const cbDuration = Date.now() - cbStart;
          if (cbDuration > 1000) {
            logger.debug(`Refresh performance`, { name: cb.name, durationMs: cbDuration, refreshed: result.refreshed, reason: result.reason }, 'Maintenance');
          } else if (result.refreshed) {
            logger.info(`Codebase refreshed`, { name: cb.name, filesUpdated: result.filesUpdated }, 'Maintenance');
          }
        } catch (err) {
          logger.error(`Failed to refresh`, err, { name: cb.name }, 'Maintenance');
          this.stats.errors++;
        }
      }

      this.stats.totalRefreshes++;
      this.lastRun = new Date().toISOString();
      
      const duration = Date.now() - startTime;
      logger.info(`Maintenance cycle complete`, { durationMs: duration }, 'Maintenance');
      this.stats.totalCycles++;
    } catch (err) {
      logger.error(`Maintenance cycle failed`, err, {}, 'Maintenance');
      this.stats.errors++;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Check if codebase needs refresh and update if needed
   */
  async checkAndRefresh(codebaseName) {
    const totalStart = Date.now();
    
    const t0 = Date.now();
    const codebase = await this.service._getCodebase(codebaseName);
    const metadata = await this.service._loadCodebaseMetadata(codebaseName);
    const loadTime = Date.now() - t0;
    
    if (!metadata) {
      return { refreshed: false, reason: 'no_metadata' };
    }

    // Scan current files
    const t1 = Date.now();
    const currentFiles = new Map();
    await this._scanDirectory(metadata.source, metadata.source, currentFiles);
    const scanTime = Date.now() - t1;

    // Get indexed files
    const t2 = Date.now();
    const indexedFiles = await codebase.metadata.getAllFiles();
    const indexedMap = new Map(indexedFiles.map(f => [f.path, f]));
    const loadIndexedTime = Date.now() - t2;

    // Find changes
    const t3 = Date.now();
    const toUpdate = [];
    const toDelete = [];
    const toAdd = [];

    for (const [path, fileInfo] of currentFiles) {
      const indexed = indexedMap.get(path);
      if (!indexed) {
        toAdd.push(fileInfo);
      } else if (fileInfo.mtime > indexed.mtime) {
        toUpdate.push(fileInfo);
      }
    }

    for (const [path] of indexedMap) {
      if (!currentFiles.has(path) || this._shouldIgnore(path, false)) {
        toDelete.push(path);
      }
    }
    const diffTime = Date.now() - t3;

    const totalChanges = toAdd.length + toUpdate.length + toDelete.length;
    
    const totalTime = Date.now() - totalStart;
    if (totalTime > 500 || totalChanges > 0) {
      logger.debug(`checkAndRefresh performance`, { 
        name: codebaseName, 
        durationMs: totalTime,
        loadMs: loadTime,
        scanMs: scanTime,
        loadIndexedMs: loadIndexedTime,
        diffMs: diffTime,
        added: toAdd.length,
        updated: toUpdate.length,
        deleted: toDelete.length
      }, 'Maintenance');
    }
    
    if (totalChanges === 0) {
      return { refreshed: false, reason: 'up_to_date' };
    }

    if (!this.config.autoRefresh) {
      return { 
        refreshed: false, 
        reason: 'auto_refresh_disabled',
        pendingChanges: { added: toAdd.length, updated: toUpdate.length, deleted: toDelete.length }
      };
    }

    // Run incremental refresh
    const refreshStart = Date.now();
    logger.info(`Codebase refresh`, { 
      name: codebaseName,
      added: toAdd.length,
      updated: toUpdate.length,
      deleted: toDelete.length
    }, 'Maintenance');
    
    await this.service.refreshCodebase({ name: codebaseName }, (progress) => {
      if (progress.phase === 'error') {
        logger.error(`Refresh progress error`, { name: codebaseName, message: progress.message }, 'Maintenance');
      }
    });

    const refreshTime = Date.now() - refreshStart;
    logger.debug(`Refresh performance`, { name: codebaseName, durationMs: refreshTime }, 'Maintenance');

    this.stats.filesUpdated += totalChanges;

    // Trigger LLM analysis if significant changes
    if (totalChanges >= 5 || (toAdd.length > 0 && toAdd.some(p => /^package\.json$|^Cargo\.toml$|^pyproject\.toml$|^go\.mod$/.test(p)))) {
      logger.info(`Significant changes detected`, { name: codebaseName, changes: totalChanges }, 'Maintenance');
      this.service.analyzeCodebase({ name: codebaseName }).catch(err => {
        logger.error(`Background analysis failed`, err, { name: codebaseName }, 'Maintenance');
      });
    }

    return {
      refreshed: true,
      filesUpdated: totalChanges,
      added: toAdd.length,
      updated: toUpdate.length,
      deleted: toDelete.length
    };
  }

  /**
   * Check if a specific file is stale (changed since indexing)
   */
  async isFileStale(codebaseName, filePath) {
    const codebase = await this.service._getCodebase(codebaseName);
    const fileInfo = await codebase.metadata.getFile(filePath);
    
    if (!fileInfo) {
      return { stale: true, reason: 'not_indexed' };
    }

    const metadata = await this.service._loadCodebaseMetadata(codebaseName);
    const fullPath = path.join(metadata.source, filePath);

    try {
      const stats = await fs.stat(fullPath);
      const isStale = stats.mtimeMs > fileInfo.mtime;
      
      return {
        stale: isStale,
        lastIndexed: fileInfo.lastIndexed,
        fileMtime: new Date(stats.mtimeMs).toISOString(),
        indexMtime: new Date(fileInfo.mtime).toISOString()
      };
    } catch {
      return { stale: true, reason: 'file_not_found' };
    }
  }

  /**
   * Get staleness report for entire codebase
   */
  async getStalenessReport(codebaseName) {
    const codebase = await this.service._getCodebase(codebaseName);
    const metadata = await this.service._loadCodebaseMetadata(codebaseName);
    const indexedFiles = await codebase.metadata.getAllFiles();
    
    const staleFiles = [];
    const missingFiles = [];
    
    for (const file of indexedFiles) {
      const fullPath = path.join(metadata.source, file.path);
      
      try {
        const stats = await fs.stat(fullPath);
        if (stats.mtimeMs > file.mtime) {
          staleFiles.push({
            path: file.path,
            lastIndexed: new Date(file.mtime).toISOString(),
            lastModified: new Date(stats.mtimeMs).toISOString()
          });
        }
      } catch {
        missingFiles.push(file.path);
      }
    }

    return {
      codebase: codebaseName,
      totalFiles: indexedFiles.length,
      staleFiles: staleFiles.length,
      missingFiles: missingFiles.length,
      lastIndexed: metadata?.lastIndexed,
      status: staleFiles.length > 0 || missingFiles.length > 0 ? 'stale' : 'current',
      details: { staleFiles, missingFiles }
    };
  }

  /**
   * Scan directory for current files
   * Only tracks code files that would be indexed (same as indexer)
   */
  async _scanDirectory(basePath, currentPath, files) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(basePath, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        if (!this._shouldIgnore(relativePath, true)) {
          await this._scanDirectory(basePath, fullPath, files);
        }
      } else if (entry.isFile()) {
        if (!this._shouldIgnore(relativePath, false)) {
          const stats = await fs.stat(fullPath).catch(() => null);
          const maxSize = this.service.config?.maxFileSize || 1024 * 1024;
          if (stats && stats.size <= maxSize) {
            files.set(relativePath, {
              path: relativePath,
              mtime: stats.mtimeMs,
              size: stats.size
            });
          }
        }
      }
    }
  }

  _shouldIgnore(relativePath, isDirectory) {
    // Use service config ignore patterns, with defaults
    const patterns = this.service.config?.ignorePatterns || [
      'node_modules/**', '.git/**', '.vscode/**', 'dist/**', 'build/**',
      '.next/**', 'target/**', '*.log', '*.lock', '*.map', '**/*.min.js', '**/*.d.ts'
    ];
    for (const pattern of patterns) {
      if (this._matchGlob(relativePath, pattern)) return true;
    }
    return false;
  }

  _matchGlob(path, pattern) {
    // Handle ** globstar specially - it means "match any path containing this"
    const hasGlobstar = pattern.includes('**');

    if (hasGlobstar) {
      // For patterns like **/something/**, we need to match the literal directory
      // at any boundary position in the path
      const parts = pattern.split('**');
      if (parts.length === 3 && parts[0] === '' && parts[2] === '') {
        // Pattern is **/something/**
        const middle = parts[1]; // e.g., /node_modules/
        const dir = middle.replace(/^\//, '').replace(/\/$/, ''); // node_modules
        // Match if path contains /dir/ or starts with dir/
        const escaped = dir.replace(/[.+^$|()[\]\\]/g, '\\$&');
        const regex = new RegExp(`(^|/)${escaped}(/|$)`);
        return regex.test(path);
      }
    }

    // For patterns without **, do standard glob-to-regex conversion
    let regex = pattern
      .replace(/\*\*/g, '{{GLOBSTAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '.')
      .replace(/\{\{GLOBSTAR\}\}/g, '.*');
    return new RegExp(`^${regex}$`).test(path);
  }

  /**
   * Get maintenance statistics
   */
  getStats() {
    return {
      ...this.stats,
      lastRun: this.lastRun,
      isRunning: this.isRunning,
      enabled: this.config.enabled,
      intervalMinutes: this.config.intervalMs / 60000
    };
  }
}
