/**
 * Live Grep - ripgrep integration for exact text search
 * 
 * Spawns ripgrep process for real-time results (no staleness)
 * Features: Caching, parallel threads, file size limits, early termination
 */

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

class GrepCache {
  constructor(maxSize = 100, ttlMs = 60000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  _makeKey(sourceDir, pattern, options) {
    const key = JSON.stringify({ sourceDir, pattern, options });
    return createHash('md5').update(key).digest('hex');
  }

  async _getDirFingerprint(sourceDir) {
    try {
      const stats = await fs.stat(sourceDir);
      return stats.mtimeMs.toString();
    } catch {
      return Date.now().toString();
    }
  }

  async get(sourceDir, pattern, options) {
    const key = this._makeKey(sourceDir, pattern, options);
    const entry = this.cache.get(key);

    if (!entry) return null;

    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }

    const currentFingerprint = await this._getDirFingerprint(sourceDir);
    if (currentFingerprint !== entry.fingerprint) {
      this.cache.delete(key);
      return null;
    }

    return entry.results;
  }

  async set(sourceDir, pattern, options, results) {
    const key = this._makeKey(sourceDir, pattern, options);
    const fingerprint = await this._getDirFingerprint(sourceDir);

    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(key, {
      results,
      timestamp: Date.now(),
      fingerprint
    });
  }

  clear() {
    this.cache.clear();
  }
}

export class GrepSearcher {
  constructor() {
    this.cache = new GrepCache(100, 60000);
  }

  async grep(sourceDir, pattern, options = {}) {
    const {
      regex = true,
      pathPattern,
      limit = 50,
      maxMatchesPerFile = 5,
      caseSensitive = false,
      timeoutMs = 5000,
      noCache = false,
      excludeExtensions = null
    } = options;

    if (!noCache) {
      const cached = await this.cache.get(sourceDir, pattern, options);
      if (cached) return cached;
    }

    let results;
    try {
      results = await this._grepRipgrep(sourceDir, pattern, {
        regex, pathPattern, limit, maxMatchesPerFile, caseSensitive, timeoutMs, excludeExtensions
      });
    } catch (err) {
      if (err.message.includes('ripgrep not found')) {
        results = await this._grepJavascript(sourceDir, pattern, {
          regex, pathPattern, limit, maxMatchesPerFile, caseSensitive, excludeExtensions
        });
      } else {
        throw err;
      }
    }

    if (!noCache) {
      await this.cache.set(sourceDir, pattern, options, results);
    }

    return results;
  }

  _grepRipgrep(sourceDir, pattern, options) {
    const { regex, pathPattern, limit, maxMatchesPerFile, caseSensitive, timeoutMs, excludeExtensions } = options;

    const args = [
      regex ? '--regexp' : '--fixed-strings',
      pattern,
      '--line-number',
      '--column',
      '--threads', '0',
      '--max-filesize', '1M',
      '--max-depth', '20',
      '--json',
      // Exclude Windows reserved names that can appear on UNC shares
      '--glob', '!nul',
      '--glob', '!con',
      '--glob', '!prn',
      '--glob', '!aux',
      '--glob', '!node_modules/**',
      '--glob', '!.git/**',
      '--glob', '!dist/**',
      '--glob', '!build/**',
      '--glob', '!target/**',
      '--glob', '!*.map',
      '--glob', '!*.min.js',
      '--glob', '!*.lock',
      '--glob', '!package-lock.json',
      '--glob', '!Cargo.lock',
      '--glob', '!*.bin',
      '--glob', '!*.exe',
      '--glob', '!*.dll',
      '--glob', '!*.so',
      '--glob', '!*.dylib'
    ];

    if (excludeExtensions && excludeExtensions.length > 0) {
      for (const ext of excludeExtensions) {
        const glob = ext.startsWith('.') ? `!*${ext}` : `!*.${ext}`;
        args.push('--glob', glob);
      }
    }

    if (caseSensitive) {
      args.push('--case-sensitive');
    } else {
      args.push('--smart-case');
    }

    if (pathPattern) {
      args.push('--glob', pathPattern);
    }

    return new Promise((resolve, reject) => {
      const results = [];
      let matchCount = 0;
      const fileMatchCounts = new Map();
      const rg = spawn('rg', args, {
        cwd: sourceDir,
        stdio: [0, 'pipe', 'pipe'],  // Inherit stdin to avoid Windows creating 'nul' file on UNC paths
        windowsHide: true
      });

      let stderr = '';
      let killedEarly = false;

      rg.stdout.on('data', (data) => {
        if (matchCount >= limit) {
          if (!killedEarly) {
            killedEarly = true;
            rg.kill('SIGTERM');
          }
          return;
        }

        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (matchCount >= limit) break;
          if (!line.trim()) continue;

          try {
            const parsed = JSON.parse(line);
            if (parsed.type === 'match') {
              const match = parsed.data;
              const filePath = match.path.text;

              const currentFileMatches = fileMatchCounts.get(filePath) || 0;
              if (maxMatchesPerFile > 0 && currentFileMatches >= maxMatchesPerFile) {
                continue;
              }

              fileMatchCounts.set(filePath, currentFileMatches + 1);

              results.push({
                path: filePath,
                line: match.line_number,
                column: match.submatches[0]?.start || 0,
                content: match.lines.text?.trim() || '',
                match: match.submatches[0]?.match?.text || ''
              });
              matchCount++;
            }
          } catch {}
        }
      });

      rg.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      rg.on('close', (code) => {
        if (code === 0 || code === 1 || code === null) {
          resolve(results);
        } else {
          reject(new Error('ripgrep failed: ' + (stderr || 'exit code ' + code)));
        }
      });

      rg.on('error', (err) => {
        if (err.code === 'ENOENT') {
          reject(new Error('ripgrep not found'));
        } else {
          reject(err);
        }
      });

      const timeoutId = setTimeout(() => {
        rg.kill('SIGTERM');
        resolve(results);
      }, timeoutMs);

      rg.on('close', () => {
        clearTimeout(timeoutId);
      });
    });
  }

  async _grepJavascript(sourceDir, pattern, options) {
    const { limit = 50, regex = true, maxMatchesPerFile = -1, caseSensitive = false, excludeExtensions = null } = options;
    const results = [];

    const flags = caseSensitive ? '' : 'i';
    const searchRegex = regex ? new RegExp(pattern, flags) : new RegExp(this._escapeRegex(pattern), flags);

    const textExtensions = new Set([
      '.js', '.ts', '.jsx', '.tsx', '.py', '.rs', '.java', '.go', '.c', '.cpp', '.h', '.cs',
      '.rb', '.php', '.swift', '.kt', '.scala', '.json', '.yaml', '.yml', '.toml', '.md',
      '.txt', '.xml', '.html', '.css', '.scss', '.less', '.sh', '.bash', '.zsh', '.fish',
      '.lua', '.r', '.sql', '.graphql', '.vue', '.svelte', '.astro', '.prisma'
    ]);

    const excludeSet = new Set((excludeExtensions || []).map(e => e.startsWith('.') ? e : '.' + e));

    const ignorePatterns = [/node_modules/, /\.git/, /dist/, /build/, /target/, /\.next/, /coverage/, /\.nyc_output/];

    const fileMatchCounts = new Map();

    async function searchDir(dir) {
      if (results.length >= limit) return;

      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);

      for (const entry of entries) {
        if (results.length >= limit) break;

        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(sourceDir, fullPath).replace(/\\/g, '/');

        if (ignorePatterns.some(p => p.test(relativePath))) continue;

        if (entry.isDirectory()) {
          await searchDir(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (excludeSet.has(ext)) continue;
          if (!textExtensions.has(ext)) continue;

          const stats = await fs.stat(fullPath).catch(() => null);
          if (!stats || stats.size > 1024 * 1024) continue;

          try {
            const content = await fs.readFile(fullPath, 'utf-8');
            const lines = content.split('\n');

            for (let i = 0; i < lines.length && results.length < limit; i++) {
              const line = lines[i];
              const match = line.match(searchRegex);
              if (match) {
                const currentCount = fileMatchCounts.get(relativePath) || 0;
                if (maxMatchesPerFile > 0 && currentCount >= maxMatchesPerFile) {
                  break;
                }
                fileMatchCounts.set(relativePath, currentCount + 1);

                results.push({
                  path: relativePath,
                  line: i + 1,
                  column: match.index || 0,
                  content: line.trim().slice(0, 200),
                  match: match[0]
                });
              }
            }
          } catch {}
        }
      }
    }

    await searchDir(sourceDir);
    return results;
  }

  _escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
