/**
 * Indexer - File walking, parsing, and embedding generation
 * 
 * Phase 4 improvements:
 * - Batch embedding generation (2-3x faster)
 * - Better progress reporting (current file, rate)
 * - Error collection (don't stop on bad files)
 * - Cancel support
 */

import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { parseJavaScript, parseTypeScript, parsePython, parseRust } from './parser/index.js';

const PARSERS = {
  '.js': parseJavaScript,
  '.ts': parseTypeScript,
  '.jsx': parseJavaScript,
  '.tsx': parseTypeScript,
  '.py': parsePython,
  '.rs': parseRust
};

// Known binary file extensions - these are never read, only indexed by name
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp',
  '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.wav', '.ogg', '.webm',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
  '.db', '.sqlite', '.sqlite3',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.swf', '.flv', '.f4v',
  '.psd', '.ai', '.eps', '.raw',
  '.class', '.o', '.obj', '.lib', '.a', '.lib',
  '.pyc', '.pyo', '.pyd',
  '.d.ts', // TypeScript declarations are just metadata
  '.min.js', '.min.css', // minified files
  '.lock', '.log',
  '.ndb', '.reg', '.wal', '.idx'
]);

export class Indexer {
  constructor(config, llmRouter) {
    this.config = config;
    this.router = llmRouter;
    this.cancelled = false;
  }

  cancel() {
    this.cancelled = true;
  }

  async indexDirectory({ source, collection, metadata, incremental = false, onProgress }) {
    const startTime = Date.now();
    this.cancelled = false;
    
    // Get existing files if incremental
    const t0 = Date.now();
    const existingFiles = incremental 
      ? new Map((await metadata.getAllFiles()).map(f => [f.path, f]))
      : new Map();
    console.log(`[Indexer:perf] Phase 0 - Load existing files: ${Date.now() - t0}ms (${existingFiles.size} existing)`);

    // Walk directory
    const t1 = Date.now();
    onProgress?.({ phase: 'scanning', message: 'Scanning files...' });
    const filesToIndex = [];
    await this._walkDirectory(source, source, filesToIndex);
    console.log(`[Indexer:perf] Phase 0 - Walk directory: ${Date.now() - t1}ms (${filesToIndex.length} files found)`);

    // Determine what to index
    const t2 = Date.now();
    const toIndex = [];
    const toDelete = [];

    for (const file of filesToIndex) {
      if (this.cancelled) throw new Error('Indexing cancelled');
      
      const existing = existingFiles.get(file.relativePath);
      
      if (!existing) {
        toIndex.push(file);
      } else if (existing.mtime < file.mtime) {
        toIndex.push(file);
        existingFiles.delete(file.relativePath);
      } else {
        existingFiles.delete(file.relativePath);
      }
    }

    for (const [p] of existingFiles) {
      toDelete.push(p);
    }
    console.log(`[Indexer:perf] Phase 0 - Diff calculation: ${Date.now() - t2}ms (toIndex=${toIndex.length}, toDelete=${toDelete.length})`);

    const totalFiles = toIndex.length;
    onProgress?.({ 
      phase: 'indexing', 
      total: totalFiles, 
      current: 0, 
      message: totalFiles === 0 ? 'Nothing to index' : `Indexing ${totalFiles} files` 
    });

    // Delete removed files
    if (toDelete.length > 0) {
      const t3 = Date.now();
      for (const filePath of toDelete) {
        metadata.stageDelete(filePath);
        try {
          collection.delete(filePath);
        } catch {
          // May not exist in collection
        }
      }
      await metadata.commit();
      console.log(`[Indexer:perf] Phase 0 - Delete ${toDelete.length} removed files: ${Date.now() - t3}ms`);
    }

    if (totalFiles === 0) {
      const totalDuration = Date.now() - startTime;
      console.log(`[Indexer:perf] Total: ${totalDuration}ms (nothing to index)`);
      return { indexed: 0, errors: 0, duration: totalDuration, errorsDetail: [], timing: { totalMs: totalDuration } };
    }

    // Process files in batches for embeddings
    const EMBED_BATCH_SIZE = 25;
    const DB_BATCH_SIZE = 50;
    
    let indexed = 0;
    const errors = [];
    let processedCount = 0;
    let lastProgressTime = Date.now();

    // Phase 1: Parse all files and prepare embedding texts
    const phase1Start = Date.now();
    const parsedFiles = [];
    let parseReadTime = 0;
    let parseHashTime = 0;
    let parseRegexTime = 0;
    let parseEmbedPrepTime = 0;
    let parseBinarySkip = 0;
    let parseFileReadCount = 0;
    
    for (let i = 0; i < toIndex.length; i++) {
      const fileInfo = toIndex[i];
      
      try {
        if (fileInfo.isBinary) {
          parseBinarySkip++;
          parsedFiles.push({ ...fileInfo, hash: null, content: null, symbols: { functions: [], classes: [], imports: [] }, embeddingText: fileInfo.relativePath });
        } else {
          parseFileReadCount++;
          const pr = await this._parseFileTimed(fileInfo);
          parseReadTime += pr.readTime;
          parseHashTime += pr.hashTime;
          parseRegexTime += pr.regexTime;
          parseEmbedPrepTime += pr.embedPrepTime;
          if (pr.result) {
            parsedFiles.push({ ...fileInfo, ...pr.result });
          }
        }
      } catch (err) {
        errors.push({ file: fileInfo.relativePath, error: err.message });
      }
      
      if ((i + 1) % 50 === 0) {
        onProgress?.({
          phase: 'parsing',
          total: totalFiles,
          current: i + 1,
          message: `Parsed ${i + 1}/${totalFiles} files`
        });
      }
    }
    const phase1Duration = Date.now() - phase1Start;
    console.log(`[Indexer:perf] Phase 1 - Parsing (${parsedFiles.length} files, ${parseBinarySkip} binary, ${parseFileReadCount} read): ${phase1Duration}ms`);
    console.log(`[Indexer:perf]   readFile: ${parseReadTime}ms, hash: ${parseHashTime}ms, regex: ${parseRegexTime}ms, embedPrep: ${parseEmbedPrepTime}ms`);

    const NOISE_FILENAMES = new Set([
      '.gitignore', '.gitmodules', '.gitattributes', '.dockerignore', '.eslintignore', '.prettierignore',
      '.npmrc', '.yarnrc', '.nvmrc',
      'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'cargo.lock', 'gemfile.lock', 'poetry.lock'
    ]);
    
    const isNoiseDesc = (p) => {
      const name = p.relativePath.split('/').pop().toLowerCase();
      // Purely declarative files
      if (NOISE_FILENAMES.has(name)) return true;
      // Too little content
      return !p.content || p.content.trim().length < 50;
    };

    const embeddableFiles = parsedFiles.filter(p => !isNoiseDesc(p));
    const noiseFiles = parsedFiles.filter(p => isNoiseDesc(p));
    if (noiseFiles.length > 0) {
      console.log(`[Indexer:perf] Noise filter: ${noiseFiles.length} files skipped from embedding (binary/empty/small/declarative)`);
    }

    // Phase 2: Batch generate embeddings (only for content-bearing files)
    const phase2Start = Date.now();
    const embeddings = [];
    let embedBatchCount = 0;
    let embedTotalServerTime = 0;
    
    for (let i = 0; i < embeddableFiles.length; i += EMBED_BATCH_SIZE) {
      if (this.cancelled) throw new Error('Indexing cancelled');
      
      const batch = embeddableFiles.slice(i, i + EMBED_BATCH_SIZE);
      const texts = batch.map(p => p.embeddingText);
      
      try {
        const bt0 = Date.now();
        const vectors = await this.router.embedBatch(texts);
        const bt1 = Date.now();
        embedBatchCount++;
        embedTotalServerTime += (bt1 - bt0);
        
        for (let j = 0; j < batch.length; j++) {
          embeddings.push({
            ...batch[j],
            vector: vectors[j]
          });
        }
      } catch (err) {
        for (const item of batch) {
          try {
            const bt0 = Date.now();
            const vector = await this.router.embedText(item.embeddingText);
            embedTotalServerTime += (Date.now() - bt0);
            embeddings.push({ ...item, vector });
          } catch (e) {
            errors.push({ file: item.relativePath, error: e.message });
          }
        }
      }
      
      const now = Date.now();
      if (now - lastProgressTime > 500) {
        const rate = embeddings.length / ((now - startTime) / 1000);
        onProgress?.({
          phase: 'embedding',
          total: totalFiles,
          current: Math.min(i + EMBED_BATCH_SIZE, embeddableFiles.length),
          message: `Embedded ${Math.min(i + EMBED_BATCH_SIZE, embeddableFiles.length)}/${embeddableFiles.length} files (${rate.toFixed(1)}/s)`,
          rate
        });
        lastProgressTime = now;
      }
    }
    const phase2Duration = Date.now() - phase2Start;
    console.log(`[Indexer:perf] Phase 2 - Embedding (${embeddings.length} files, ${embedBatchCount} batches): ${phase2Duration}ms (server: ${embedTotalServerTime}ms)`);

    // Phase 3: Batch insert into nVDB and SQLite
    const phase3Start = Date.now();
    let nvdbInsertTime = 0;
    let metaSaveTime = 0;
    let metaJsonSerializeTime = 0;
    let metaJsonWriteTime = 0;
    let contentIndexTime = 0;
    
    for (let i = 0; i < embeddings.length; i += DB_BATCH_SIZE) {
      if (this.cancelled) throw new Error('Indexing cancelled');
      
      const batch = embeddings.slice(i, i + DB_BATCH_SIZE);
      
      for (const item of batch) {
        try {
          const nvdb0 = Date.now();
          collection.insert(item.relativePath, item.vector, JSON.stringify({
            path: item.relativePath,
            language: this._getLanguage(item.ext),
            size: item.size,
            functions: item.symbols.functions,
            classes: item.symbols.classes,
            imports: item.symbols.imports
          }));
          nvdbInsertTime += Date.now() - nvdb0;
          
          metadata.stageFile(item.relativePath, {
            mtime: item.mtime,
            size: item.size,
            hash: item.hash,
            language: this._getLanguage(item.ext)
          });
          
          indexed++;
        } catch (err) {
          errors.push({ file: item.relativePath, error: err.message });
        }
      }
      
      const commit0 = Date.now();
      await metadata.commit();
      metaSaveTime += Date.now() - commit0;
      
      processedCount += batch.length;
      
      const now = Date.now();
      const rate = processedCount / ((now - startTime) / 1000);
      onProgress?.({
        phase: 'storing',
        total: totalFiles,
        current: processedCount,
        message: `Stored ${processedCount}/${totalFiles} files (${rate.toFixed(1)}/s)`,
        rate
      });
    }
    
    const phase3Duration = Date.now() - phase3Start;
    console.log(`[Indexer:perf] Phase 3 - Storage (${indexed} files): ${phase3Duration}ms`);
    console.log(`[Indexer:perf]   nVDB insert: ${nvdbInsertTime}ms, metadata.saveFile: ${metaSaveTime}ms`);
    
    if (noiseFiles.length > 0) {
      const noiseStart = Date.now();
      for (const nf of noiseFiles) {
        metadata.stageFile(nf.relativePath, {
          mtime: nf.mtime,
          size: nf.size,
          hash: nf.hash,
          language: this._getLanguage(nf.ext)
        });
      }
      await metadata.commit();
      indexed += noiseFiles.length;
      console.log(`[Indexer:perf] Noise files: stored ${noiseFiles.length} in metadata only (${Date.now() - noiseStart}ms)`);
    }
    
    const totalDuration = Date.now() - startTime;
    console.log(`[Indexer:perf] TOTAL: ${totalDuration}ms (rate: ${(indexed / (totalDuration / 1000)).toFixed(1)}/s)`);
    
    return {
      indexed,
      errors: errors.length,
      duration: totalDuration,
      errorsDetail: errors.slice(0, 10),
      rate: indexed / (totalDuration / 1000),
      timing: {
        totalMs: totalDuration,
        existingFilesMs: t1 - t0,
        walkMs: t2 - t1,
        diffMs: Date.now() - t2 - (toDelete.length > 0 ? 0 : 0),
        phase1ParseMs: phase1Duration,
        phase2EmbedMs: phase2Duration,
        phase3StoreMs: phase3Duration,
        nvdbInsertMs: nvdbInsertTime,
        metadataSaveMs: metaSaveTime,
        parseReadMs: parseReadTime,
        parseHashMs: parseHashTime,
        parseRegexMs: parseRegexTime,
        embedServerMs: embedTotalServerTime
      }
    };
  }

  async _parseFile(fileInfo) {
    const { fullPath, relativePath, mtime, size, ext, isBinary } = fileInfo;

    if (isBinary) {
      return {
        relativePath,
        mtime,
        size,
        ext,
        hash: null,
        content: null,
        symbols: { functions: [], classes: [], imports: [] },
        embeddingText: relativePath
      };
    }

    const content = await fs.readFile(fullPath, 'utf-8');
    const hash = createHash('md5').update(content).digest('hex');

    const parser = PARSERS[ext];
    const symbols = parser ? parser(content) : { functions: [], classes: [], imports: [] };

    const embeddingText = this._prepareEmbeddingText(relativePath, content, symbols);

    return {
      relativePath,
      mtime,
      size,
      ext,
      hash,
      content,
      symbols,
      embeddingText
    };
  }

  async _parseFileTimed(fileInfo) {
    const { fullPath, relativePath, mtime, size, ext } = fileInfo;

    const r0 = Date.now();
    const content = await fs.readFile(fullPath, 'utf-8');
    const readTime = Date.now() - r0;

    const h0 = Date.now();
    const hash = createHash('md5').update(content).digest('hex');
    const hashTime = Date.now() - h0;

    const x0 = Date.now();
    const parser = PARSERS[ext];
    const symbols = parser ? parser(content) : { functions: [], classes: [], imports: [] };
    const regexTime = Date.now() - x0;

    const e0 = Date.now();
    const embeddingText = this._prepareEmbeddingText(relativePath, content, symbols);
    const embedPrepTime = Date.now() - e0;

    return {
      readTime, hashTime, regexTime, embedPrepTime,
      result: {
        relativePath,
        mtime,
        size,
        ext,
        hash,
        content,
        symbols,
        embeddingText
      }
    };
  }

  /**
   * Walk directory and collect files
   */
  async _walkDirectory(basePath, currentPath, files) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(basePath, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        if (this._shouldIgnore(relativePath, true)) continue;
        await this._walkDirectory(basePath, fullPath, files);
      } else if (entry.isFile()) {
        if (this._shouldIgnore(relativePath, false)) continue;

        const stats = await fs.stat(fullPath);
        if (stats.size > this.config.maxFileSize) continue;

        const ext = path.extname(entry.name).toLowerCase();
        const isKnownBinary = BINARY_EXTENSIONS.has(ext);

        // Also check for extension-based patterns that indicate binary/minified
        const fileName = entry.name.toLowerCase();
        const isMinifiedOrGenerated = fileName.endsWith('.min.js') || fileName.endsWith('.min.css') ||
            fileName.endsWith('.map') || fileName.endsWith('.d.ts') ||
            fileName.endsWith('.lock') || fileName.endsWith('.log');

        // For known binary extensions or detected binary content, index by name only
        let isBinary = isKnownBinary || isMinifiedOrGenerated;
        let content = null;

        if (!isBinary) {
          // Check for null bytes (unknown binary files)
          try {
            const fd = await fs.open(fullPath, 'r');
            const buffer = Buffer.alloc(1024);
            const { bytesRead } = await fd.read(buffer, 0, 1024, 0);
            await fd.close();

            // Check for null bytes = binary file
            if (bytesRead > 0 && buffer.slice(0, bytesRead).includes(0)) {
              isBinary = true;
            }
          } catch {
            isBinary = true; // Can't read, treat as binary
          }
        }

        // Index file regardless (binary files indexed by name only)
        files.push({
          fullPath,
          relativePath,
          mtime: stats.mtimeMs,
          size: stats.size,
          ext,
          isBinary
        });
      }
    }
  }

  _shouldIgnore(relativePath, isDirectory) {
    for (const pattern of this.config.ignorePatterns) {
      if (this._matchGlob(relativePath, pattern)) return true;
    }
    return false;
  }

  _matchGlob(path, pattern) {
    // Convert glob pattern to regex
    // Handle ** globstar specially - it means "match any path containing this"
    // Single * matches within a single path segment (no slashes)
    // ** matches zero or more path segments

    // For patterns like **/node_modules/** or **/foo/**, we need to match
    // the literal directory name at any boundary position in the path
    const hasGlobstar = pattern.includes('**');

    if (hasGlobstar) {
      // For patterns with **, match the literal part after **/
      // e.g., **/node_modules/** should match paths CONTAINING node_modules/
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
      .replace(/\/\{\{GLOBSTAR\}\}$/, '(?:/.*)?')
      .replace(/^\{\{GLOBSTAR\}\}\//, '(?:.*/)?')
      .replace(/\{\{GLOBSTAR\}\}/g, '.*');

    return new RegExp(`^${regex}$`).test(path);
  }

  _prepareEmbeddingText(filePath, content, symbols) {
    // Prioritize symbols - they define what the file IS
    const symbolNames = [
      ...symbols.functions.map(f => f.name),
      ...symbols.classes.map(c => c.name)
    ].join(' ');
    
    // Repeat symbols for weight + smaller content sample
    const contentSample = content.slice(0, 1000);
    
    // Format: path + repeated symbols + content
    // Repeating symbols gives them more weight in the embedding
    return `${filePath} ${symbolNames} ${symbolNames} ${contentSample}`;
  }

  _getLanguage(ext) {
    const mapping = {
      '.js': 'javascript',
      '.ts': 'typescript',
      '.jsx': 'javascript',
      '.tsx': 'typescript',
      '.py': 'python',
      '.rs': 'rust',
      '.java': 'java',
      '.go': 'go',
      '.rb': 'ruby',
      '.php': 'php',
      '.cpp': 'cpp',
      '.cc': 'cpp',
      '.cxx': 'cpp',
      '.c': 'c',
      '.h': 'c',
      '.hpp': 'cpp',
      '.cs': 'csharp',
      '.swift': 'swift',
      '.kt': 'kotlin',
      '.scala': 'scala',
      '.r': 'r',
      '.m': 'objective-c',
      '.mm': 'objective-cpp',
      '.pl': 'perl',
      '.lua': 'lua',
      '.groovy': 'groovy',
      '.dart': 'dart',
      '.elm': 'elm',
      '.erl': 'erlang',
      '.hrl': 'erlang',
      '.ex': 'elixir',
      '.exs': 'elixir',
      '.fs': 'fsharp',
      '.fsx': 'fsharp',
      '.hs': 'haskell',
      '.lhs': 'haskell',
      '.jl': 'julia',
      '.ml': 'ocaml',
      '.mli': 'ocaml',
      '.nim': 'nim',
      '.pas': 'pascal',
      '.pp': 'pascal',
      '.scm': 'scheme',
      '.ss': 'scheme',
      '.tcl': 'tcl',
      '.coffee': 'coffeescript',
      '.litcoffee': 'coffeescript',
      '.vb': 'vbnet',
      '.fs': 'fsharp',
      // Markup/Config/Data
      '.md': 'markdown',
      '.mdx': 'markdown',
      '.html': 'html',
      '.htm': 'html',
      '.xml': 'xml',
      '.css': 'css',
      '.scss': 'scss',
      '.sass': 'sass',
      '.less': 'less',
      '.json': 'json',
      '.yaml': 'yaml',
      '.yml': 'yaml',
      '.toml': 'toml',
      '.ini': 'ini',
      '.cfg': 'config',
      '.conf': 'config',
      '.sh': 'shell',
      '.bash': 'shell',
      '.zsh': 'shell',
      '.fish': 'shell',
      '.ps1': 'powershell',
      '.psm1': 'powershell',
      '.psd1': 'powershell',
      '.bat': 'batch',
      '.cmd': 'batch',
      '.sql': 'sql',
      '.dockerfile': 'dockerfile',
      '.tf': 'terraform',
      '.hcl': 'hcl',
      '.proto': 'protobuf',
      '.graphql': 'graphql',
      '.gql': 'graphql'
    };
    return mapping[ext] || 'text';
  }
}

// Parsers imported from ./parser/index.js (tree-sitter with regex fallback)
