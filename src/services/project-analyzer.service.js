/**
 * Project Analyzer - Metadata-based heuristic project analysis
 *
 * Generates project description, key files, and insights
 * from file structure and naming patterns alone (no LLM).
 *
 * Reads package.json / Cargo.toml / pyproject.toml / go.mod etc.
 * for tech stack detection.
 */

import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';

// Config files to check for tech stack (in priority order)
const CONFIG_FILES = [
  'package.json',
  'Cargo.toml',
  'pyproject.toml',
  'go.mod',
  'build.gradle',
  'pom.xml',
  'composer.json',
  'Gemfile',
  'mix.exs',
  'project.clj',
  'dub.json',
  'CMakeLists.txt',
  'Makefile',
  'requirements.txt',
  'Pipfile',
  'go.sum',
  'yarn.lock',
  'package-lock.json',
  'pnpm-lock.yaml'
];

const HIGH_PRIORITY_PATTERNS = [
  /^(readme|changelog|changes|history|license|copying)/i,
  /^(main|index|app|server|cli|entry|start|boot)\.(js|ts|py|go|rs|rb|java|c|cpp|cs)$/i,
  /^(main|index|app|server|cli)\.(mjs|cjs)$/i,
  /^(package|cargo|pyproject|go\.mod|build\.gradle|pom\.xml|composer\.json|gemfile|mix\.exs|cmakelists|makefile|dub\.json)$/i,
  /^src\/(index|main|app|server|cli|start)\.(js|ts|py|go|rs|rb|java|c|cpp|cs)$/i,
  /^src\/(main|app)\/(index|main|app|server)\.(js|ts|py|go|rs|rb|java|c|cpp|cs)$/i,
  /^docker-compose/i,
  /^dockerfile/i,
  /^\.env\.example$/i,
  /^tsconfig\.json$/i,
  /^vite\.config/i,
  /^webpack\.config/i,
  /^rollup\.config/i,
  /^next\.config/i,
  /^nuxt\.config/i,
  /^svelte\.config/i,
  /^astro\.config/i,
  /^tailwind\.config/i,
  /^babel\.config/i,
  /^\.eslintrc/i,
  /^\.prettierrc/i
];

const ENTRY_POINT_PATTERNS = [
  /^(main|index|server|app|cli|start|boot)\.(js|ts|mjs|cjs|py|go|rs|rb|java|c|cpp|cs)$/i,
  /^src\/(index|main|app|server|cli|start|boot)\.(js|ts|mjs|cjs|py|go|rs|rb|java|c|cpp|cs)$/i,
  /^src\/(main|app)\/(index|main|app|server)\.(js|ts|mjs|cjs|py|go|rs|rb|java|c|cpp|cs)$/i,
  /^cmd\/.+\/main\.go$/i,
  /^bin\//i
];

const MEDIUM_PRIORITY_PATTERNS = [
  /^src\/(services|lib|core|utils|helpers|middleware|routes|controllers|models|api|config|modules|components|handlers)\//i,
  /^lib\//i,
  /^internal\//i,
  /^pkg\//i,
  /^app\//i,
  /^config/i,
  /^router/i,
  /^middleware/i,
  /^database/i,
  /^migrations?\//i,
  /^\.github\//i
];

const EXCLUDE_PATTERNS = [
  /^node_modules\//,
  /^dist\//,
  /^build\//,
  /^\.git\//,
  /^__pycache__\//,
  /^\.next\//,
  /^\.nuxt\//,
  /^target\//,
  /^vendor\//,
  /^\.cache\//,
  /^_Archive\//,
  /^logs?\//,
  /^data\//,
  /\.lock$/,
  /\.log$/,
  /\.ndb$/,
  /\.min\./,
  /\.bundle\./,
  /\.map$/,
  /\.d\.ts$/
];

const KNOWN_TECH_MAP = {
  'package.json': data => {
    const deps = { ...(data.dependencies || {}), ...(data.devDependencies || {}) };
    const stack = [];
    if (deps.express || deps.fastify || deps.koa || deps.hono) stack.push('nodejs-web');
    if (deps.react) stack.push('react');
    if (deps.vue) stack.push('vue');
    if (deps.svelte) stack.push('svelte');
    if (deps.next) stack.push('nextjs');
    if (deps.nuxt) stack.push('nuxt');
    if (deps.typescript) stack.push('typescript');
    if (deps.electron) stack.push('electron');
    if (deps.tailwindcss) stack.push('tailwind');
    if (deps.prisma) stack.push('prisma');
    if (deps.mongodb || deps.mongoose) stack.push('mongodb');
    if (deps.pg || deps['pg-promise']) stack.push('postgresql');
    if (deps.sqlite3 || deps['better-sqlite3']) stack.push('sqlite');
    if (deps.redis || deps.ioredis) stack.push('redis');
    if (deps.webpack || deps.vite || deps.rollup) stack.push('bundler');
    if (deps.jest || deps.vitest || deps.mocha) stack.push('testing');
    if (deps.axios || deps['node-fetch']) stack.push('http-client');
    stack.unshift('nodejs');
    return stack;
  },
  'Cargo.toml': () => ['rust'],
  'pyproject.toml': data => {
    const stack = ['python'];
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    if (text.includes('django')) stack.push('django');
    if (text.includes('flask')) stack.push('flask');
    if (text.includes('fastapi')) stack.push('fastapi');
    if (text.includes('sqlalchemy')) stack.push('sqlalchemy');
    return stack;
  },
  'go.mod': () => ['go'],
  'build.gradle': () => ['java', 'gradle'],
  'pom.xml': () => ['java', 'maven'],
  'composer.json': () => ['php'],
  'Gemfile': () => ['ruby'],
  'mix.exs': () => ['elixir'],
  'CMakeLists.txt': () => ['cmake', 'cpp'],
  'requirements.txt': () => ['python']
};

function categorizeFiles(files) {
  const high = [];
  const medium = [];
  const low = [];
  const entryPoints = [];
  const excluded = [];

  for (const filePath of files) {
    if (EXCLUDE_PATTERNS.some(p => p.test(filePath))) {
      excluded.push(filePath);
      continue;
    }

    if (HIGH_PRIORITY_PATTERNS.some(p => p.test(filePath))) {
      high.push(filePath);
    } else if (MEDIUM_PRIORITY_PATTERNS.some(p => p.test(filePath))) {
      medium.push(filePath);
    } else if (/\.test\.|\.spec\.|_test\.|\/tests?\//i.test(filePath) || /^docs?\//i.test(filePath)) {
      low.push(filePath);
    } else {
      low.push(filePath);
    }

    if (ENTRY_POINT_PATTERNS.some(p => p.test(filePath))) {
      entryPoints.push(filePath);
    }
  }

  return {
    keyFiles: {
      high: high.slice(0, 10),
      medium: medium.slice(0, 15),
      low
    },
    entryPoints,
    exclude: ['node_modules/', 'dist/', 'build/', '.git/']
  };
}

async function detectTechStack(sourcePath) {
  const stack = new Set();
  let packageData = null;

  for (const configFile of CONFIG_FILES) {
    try {
      const fullPath = path.join(sourcePath, configFile);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (configFile === 'package.json') {
        try {
          packageData = JSON.parse(content);
          const detected = KNOWN_TECH_MAP['package.json'](packageData);
          detected.forEach(t => stack.add(t));
        } catch { /* ignore parse errors */ }
      } else if (KNOWN_TECH_MAP[configFile]) {
        const detected = KNOWN_TECH_MAP[configFile](content);
        detected.forEach(t => stack.add(t));
      }
    } catch { /* file doesn't exist */ }
  }

  return { stack: [...stack], packageData };
}

function detectCoreModules(files) {
  const dirCounts = new Map();

  for (const filePath of files) {
    const parts = filePath.split('/');
    if (parts.length >= 3) {
      const moduleDir = parts.slice(0, 3).join('/');
      dirCounts.set(moduleDir, (dirCounts.get(moduleDir) || 0) + 1);
    } else if (parts.length === 2) {
      const parentDir = parts[0];
      dirCounts.set(parentDir, (dirCounts.get(parentDir) || 0) + 1);
    }
  }

  return [...dirCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7)
    .map(([dir]) => {
      const parts = dir.split('/');
      return parts[parts.length - 1];
    });
}

function inferArchitecture(files, packageData) {
  const dirs = new Set(files.map(f => f.split('/')[0]).filter(Boolean));

  if (dirs.has('cmd') && dirs.has('internal')) return 'go-standard';
  if (dirs.has('src') && dirs.has('test')) return 'layered';
  if (dirs.has('src') && dirs.has('lib')) return 'modular';
  if (dirs.has('packages') || dirs.has('apps')) return 'monorepo';
  if (dirs.has('services') && dirs.has('packages')) return 'microservices';
  if (packageData?.workspaces) return 'monorepo';
  if (dirs.has('src')) return 'modular';
  if (dirs.has('lib')) return 'library';

  return 'flat';
}

function inferKeyConcepts(files, packageData) {
  const concepts = new Set();

  if (packageData) {
    const name = (packageData.name || '').toLowerCase();
    const desc = (packageData.description || '').toLowerCase();
    const allText = name + ' ' + desc;

    if (/api|endpoint|route|rest|graphql/.test(allText)) concepts.add('api');
    if (/auth|oauth|jwt|token/.test(allText)) concepts.add('authentication');
    if (/database|db|sql|query|orm/.test(allText)) concepts.add('database');
    if (/cache|redis|memcache/.test(allText)) concepts.add('caching');
    if (/queue|worker|job|task|cron/.test(allText)) concepts.add('task-queue');
    if (/websocket|ws|socket|realtime/.test(allText)) concepts.add('realtime');
    if (/embed|vector|search|index/.test(allText)) concepts.add('search');
    if (/test|spec|bdd/.test(allText)) concepts.add('testing');
    if (/stream|pipe|event/.test(allText)) concepts.add('streaming');
    if (/middleware|plugin|hook|extension/.test(allText)) concepts.add('middleware');
    if (/config|setting|env/.test(allText)) concepts.add('configuration');
  }

  const pathText = files.slice(0, 100).join(' ').toLowerCase();
  if (/middleware|auth/.test(pathText)) concepts.add('middleware');
  if (/route|controller|handler/.test(pathText)) concepts.add('routing');
  if (/model|schema|entity/.test(pathText)) concepts.add('data-modeling');
  if (/service|adapter|repository/.test(pathText)) concepts.add('service-layer');
  if (/component|view|page/.test(pathText)) concepts.add('ui-components');

  return [...concepts].slice(0, 7);
}

function generateDescription(files, packageData, codebaseName) {
  if (packageData?.description) {
    return String(packageData.description).slice(0, 120);
  }

  const dirs = [...new Set(files.map(f => f.split('/')[0]).filter(Boolean))];
  const langCounts = new Map();
  for (const f of files) {
    const ext = f.split('.').pop();
    langCounts.set(ext, (langCounts.get(ext) || 0) + 1);
  }
  const topLang = [...langCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const langMap = { js: 'JavaScript', ts: 'TypeScript', py: 'Python', go: 'Go', rs: 'Rust', rb: 'Ruby', java: 'Java', cpp: 'C++', c: 'C', cs: 'C#' };
  const lang = langMap[topLang?.[0]] || topLang?.[0] || 'unknown';
  const fileCount = files.length;
  const dirList = dirs.slice(0, 3).join(', ');

  if (dirList) {
    return `A ${lang} project with ${fileCount} files across ${dirList} directories`.slice(0, 120);
  }
  return `${codebaseName}: ${lang} project with ${fileCount} files`.slice(0, 120);
}

function generatePurpose(files, packageData, codebaseName) {
  if (packageData?.description) {
    return String(packageData.description).slice(0, 300);
  }

  const dirs = [...new Set(files.map(f => f.split('/')[0]).filter(Boolean))];
  return `Auto-generated summary for ${codebaseName}. Contains ${files.length} files across directories: ${dirs.slice(0, 5).join(', ')}`.slice(0, 300);
}

async function generateSourceHashes(files, sourcePath) {
  const hashes = {};

  for (const filePath of files.slice(0, 20)) {
    try {
      const fullPath = path.join(sourcePath, filePath);
      const content = await fs.readFile(fullPath, 'utf-8');
      hashes[filePath] = createHash('md5').update(content).digest('hex').slice(0, 16);
    } catch { /* skip */ }
  }

  return hashes;
}

export async function analyzeProject(router, metadata, sourcePath, onProgress) {
  const startTime = Date.now();

  const allFiles = (await metadata.getAllFiles()).map(f => f.path);

  if (allFiles.length === 0) {
    throw new Error('No files to analyze');
  }

  onProgress?.({ phase: 'analyzing', message: 'Analyzing file structure...' });

  const fileTreeAnalysis = categorizeFiles(allFiles);

  onProgress?.({ phase: 'analyzing', message: 'Detecting tech stack...' });

  const { stack: techStackList, packageData } = await detectTechStack(sourcePath);
  const coreModules = detectCoreModules(allFiles);
  const architecture = inferArchitecture(allFiles, packageData);
  const keyConcepts = inferKeyConcepts(allFiles, packageData);

  const codebaseName = path.basename(sourcePath);
  const description = generateDescription(allFiles, packageData, codebaseName);
  const purpose = generatePurpose(allFiles, packageData, codebaseName);

  const allKeyFiles = [
    ...fileTreeAnalysis.keyFiles.high,
    ...fileTreeAnalysis.keyFiles.medium
  ];
  const sourceHashes = await generateSourceHashes(allKeyFiles, sourcePath);

  const duration = Date.now() - startTime;

  return {
    analyzedAt: new Date().toISOString(),
    model: 'heuristic',
    version: '2',

    keyFiles: fileTreeAnalysis.keyFiles,
    entryPoints: fileTreeAnalysis.entryPoints,

    description,
    purpose,

    insights: {
      architecture,
      techStack: techStackList,
      keyConcepts,
      coreModules
    },

    sourceHashes,

    duration,
    filesAnalyzed: allKeyFiles.length
  };
}

export async function isAnalysisStale(analysis, sourcePath) {
  if (!analysis?.sourceHashes) return true;

  for (const [filePath, expectedHash] of Object.entries(analysis.sourceHashes)) {
    try {
      const fullPath = path.join(sourcePath, filePath);
      const content = await fs.readFile(fullPath, 'utf-8');
      const actualHash = createHash('md5').update(content).digest('hex').slice(0, 16);

      if (actualHash !== expectedHash) {
        return true;
      }
    } catch {
      return true;
    }
  }

  return false;
}

export function getPrioritizedFiles(analysis, allFiles) {
  if (!analysis?.keyFiles) {
    return { high: [], medium: [], low: allFiles };
  }

  const highSet = new Set(analysis.keyFiles.high || []);
  const mediumSet = new Set(analysis.keyFiles.medium || []);
  const lowSet = new Set(analysis.keyFiles.low || []);

  const categorized = new Set([...highSet, ...mediumSet, ...lowSet]);
  const uncategorized = allFiles.filter(f => !categorized.has(f));

  return {
    high: analysis.keyFiles.high,
    medium: analysis.keyFiles.medium,
    low: [...(analysis.keyFiles.low || []), ...uncategorized]
  };
}
