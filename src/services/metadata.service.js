/**
 * Simple Metadata Store - JSON-based file manifest
 *
 * Stores:
 * - File metadata (mtime, size, hash, language) in JSON manifest
 * - Symbols come from nVDB payload (no duplication)
 * - Full content comes from filesystem (no duplication)
 * - Content search is handled by ripgrep (grep_codebase), not indexed here
 */

import fs from 'fs/promises';
import path from 'path';
import { getLogger } from '../utils/logger.js';

const logger = getLogger();

export class SimpleMetadataStore {
  constructor(basePath) {
    this.basePath = basePath;
    this.manifestPath = path.join(basePath, 'manifest.json');
    this.cache = null;
  }

  async init() {
    await fs.mkdir(this.basePath, { recursive: true });
    
    try {
      const data = await fs.readFile(this.manifestPath, 'utf-8');
      this.cache = JSON.parse(data);
    } catch {
      this.cache = { files: {}, lastIndexed: null };
    }
  }

  async save() {
    await fs.writeFile(this.manifestPath, JSON.stringify(this.cache, null, 2));
  }

  async saveFile(filePath, { mtime, size, hash, language }) {
    this.cache.files[filePath] = {
      mtime,
      size,
      hash,
      language,
      lastIndexed: new Date().toISOString()
    };
    await this.save();
  }

  stageFile(filePath, { mtime, size, hash, language }) {
    this.cache.files[filePath] = {
      mtime,
      size,
      hash,
      language,
      lastIndexed: new Date().toISOString()
    };
  }

  async commit() {
    const t0 = Date.now();
    await this.save();
    const total = Date.now() - t0;
    if (total > 10) {
      logger.debug(`Metadata commit`, { durationMs: total, fileCount: Object.keys(this.cache.files).length }, 'Metadata');
    }
  }

  async getFile(filePath) {
    const meta = this.cache.files[filePath];
    if (!meta) return null;

    return {
      path: filePath,
      ...meta,
      stale: false
    };
  }

  async deleteFile(filePath) {
    delete this.cache.files[filePath];
    await this.save();
  }

  stageDelete(filePath) {
    delete this.cache.files[filePath];
  }

  async getAllFiles() {
    return Object.entries(this.cache.files).map(([path, data]) => ({
      path,
      ...data
    }));
  }

  get fileCount() {
    return Object.keys(this.cache.files).length;
  }

  get lastIndexed() {
    return this.cache.lastIndexed;
  }

  async setLastIndexed(date = new Date().toISOString()) {
    this.cache.lastIndexed = date;
    await this.save();
  }

  close() {
    this.cache = null;
  }

  async searchKeyword(query, limit = 20) {
    const results = [];
    const lowerQuery = query.toLowerCase();
    
    for (const [filePath, data] of Object.entries(this.cache.files)) {
      const lowerPath = filePath.toLowerCase();
      
      if (lowerPath.includes(lowerQuery)) {
        const score = lowerPath === lowerQuery ? 1.0 : 
                lowerPath.split('/').pop().includes(lowerQuery) ? 0.8 : 0.5;
        
        results.push({
          path: filePath,
          rank: -score,
          ...data
        });
      }
      
      if (results.length >= limit) break;
    }
    
    results.sort((a, b) => a.rank - b.rank);
    return results.slice(0, limit);
  }

  async getFileTree(subpath = '') {
    const entries = new Map();
    const prefix = subpath ? subpath.replace(/\/ $/, '') + '/' : '';
    
    for (const filePath of Object.keys(this.cache.files)) {
      if (subpath && !filePath.startsWith(prefix)) continue;
      
      const relativePath = subpath ? filePath.slice(prefix.length) : filePath;
      const parts = relativePath.split('/');
      
      if (parts.length === 0) continue;
      
      const firstPart = parts[0];
      if (parts.length === 1) {
        entries.set(firstPart, { name: firstPart, type: 'file' });
      } else {
        entries.set(firstPart, { name: firstPart, type: 'dir' });
      }
    }
    
    return Array.from(entries.values()).sort((a, b) => {
      if (a.type === 'dir' && b.type === 'file') return -1;
      if (a.type === 'file' && b.type === 'dir') return 1;
      return a.name.localeCompare(b.name);
    });
  }
}
