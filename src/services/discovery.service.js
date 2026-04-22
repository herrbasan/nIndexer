import fs from 'fs/promises';
import path from 'path';
import { getLogger } from '../utils/logger.js';

const logger = getLogger();

export class DiscoveryService {
  constructor(indexingService, config = {}) {
    this.indexingService = indexingService;
    this.roots = config.roots || [];
    this.scanIntervalMs = config.scanIntervalMs || 3600000;
    this.intervalId = null;
    this.isScanning = false;
    this.lastScan = null;
    this.stats = {
      totalScans: 0,
      projectsDiscovered: 0,
      projectsIndexed: 0,
      projectsRemoved: 0,
      errors: 0
    };
  }

  start() {
    if (this.roots.length === 0) {
      logger.info(`Discovery disabled - no roots configured`, {}, 'Discovery');
      return;
    }

    logger.info(`Discovery starting`, {
      roots: this.roots,
      scanIntervalMin: this.scanIntervalMs / 60000
    }, 'Discovery');

    this.scanAndSync().catch(err => {
      logger.error(`Initial discovery scan failed`, err, {}, 'Discovery');
    });

    this.intervalId = setInterval(() => {
      this.scanAndSync().catch(err => {
        logger.error(`Periodic discovery scan failed`, err, {}, 'Discovery');
      });
    }, this.scanIntervalMs);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info(`Discovery stopped`, {}, 'Discovery');
    }
  }

  async scanAndSync() {
    if (this.isScanning) {
      logger.warn(`Discovery skipped - previous scan still active`, {}, 'Discovery');
      return;
    }

    this.isScanning = true;
    const startTime = Date.now();

    try {
      const discovered = await this.discoverProjects();

      this.stats.totalScans++;
      this.stats.projectsDiscovered = discovered.length;
      this.lastScan = new Date().toISOString();

      await this.syncWithIndex(discovered);

      const duration = Date.now() - startTime;
      logger.info(`Discovery scan complete`, {
        discovered: discovered.length,
        durationMs: duration
      }, 'Discovery');
    } catch (err) {
      logger.error(`Discovery scan failed`, err, {}, 'Discovery');
      this.stats.errors++;
    } finally {
      this.isScanning = false;
    }
  }

  async discoverProjects() {
    const candidates = [];

    for (const root of this.roots) {
      try {
        const entries = await fs.readdir(root, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;

          const fullPath = path.join(root, entry.name);
          const name = toSnakeCase(entry.name);

          let mtime;
          try {
            const stat = await fs.stat(fullPath);
            mtime = stat.mtimeMs;
          } catch {
            continue;
          }

          candidates.push({ name, source: fullPath, mtime, root, folderName: entry.name });
        }
      } catch (err) {
        logger.warn(`Discovery root inaccessible`, {
          root,
          error: err.message
        }, 'Discovery');
      }
    }

    const byName = new Map();
    for (const c of candidates) {
      const existing = byName.get(c.name);
      if (!existing || c.mtime > existing.mtime) {
        byName.set(c.name, c);
      }
    }

    const resolved = [...byName.values()];
    logger.info(`Discovery resolved`, {
      raw: candidates.length,
      deduplicated: resolved.length,
      roots: this.roots.length
    }, 'Discovery');

    return resolved;
  }

  async syncWithIndex(discovered) {
    const discoveredNames = new Map(discovered.map(d => [d.name, d]));

    const indexed = await this.indexingService.listCodebases();
    const indexedMap = new Map(indexed.map(cb => [cb.name, cb]));

    const toIndex = [];
    const toRemove = [];

    for (const disc of discovered) {
      const existing = indexedMap.get(disc.name);
      if (!existing) {
        toIndex.push(disc);
      }
    }

    for (const cb of indexed) {
      if (!discoveredNames.has(cb.name)) {
        toRemove.push(cb.name);
      }
    }

    if (toRemove.length > 0) {
      logger.info(`Discovery removing stale codebases`, {
        count: toRemove.length,
        names: toRemove
      }, 'Discovery');
    }

    for (const name of toRemove) {
      try {
        await this.indexingService.removeCodebase({ name, permanent: true });
        this.stats.projectsRemoved++;
      } catch (err) {
        logger.error(`Discovery failed to remove codebase`, err, { name }, 'Discovery');
        this.stats.errors++;
      }
    }

    if (toIndex.length > 0) {
      logger.info(`Discovery indexing new codebases`, {
        count: toIndex.length,
        names: toIndex.map(d => d.name)
      }, 'Discovery');
    }

    for (const disc of toIndex) {
      if (!this.indexingService.router.embedAvailable) {
        logger.warn(`Embedding service unavailable, deferring remaining discoveries`, {
          remaining: toIndex.length - toIndex.indexOf(disc)
        }, 'Discovery');
        break;
      }

      try {
        const result = await this.indexingService.indexCodebase(
          { name: disc.name, source: disc.source, folderName: disc.folderName },
          (progress) => {
            if (progress.phase === 'error') {
              logger.error(`Discovery index error`, {
                name: disc.name,
                message: progress.message
              }, 'Discovery');
            }
          }
        );

        this.stats.projectsIndexed++;

        if (result.indexed === 0) {
          logger.info(`Discovery removing empty codebase`, { name: disc.name }, 'Discovery');
          await this.indexingService.removeCodebase({ name: disc.name, permanent: true });
          this.stats.projectsRemoved++;
        }
      } catch (err) {
        logger.error(`Discovery failed to index codebase`, err, {
          name: disc.name,
          source: disc.source
        }, 'Discovery');
        this.stats.errors++;
      }
    }
  }

  getStats() {
    return {
      ...this.stats,
      lastScan: this.lastScan,
      isScanning: this.isScanning,
      roots: this.roots,
      scanIntervalMinutes: this.scanIntervalMs / 60000
    };
  }
}

function toSnakeCase(str) {
  return str
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[\s.\-]+/g, '_')
    .toLowerCase();
}
