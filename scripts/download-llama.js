import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const binDir = path.join(projectRoot, 'bin', 'llama');
const modelsDir = path.join(binDir, 'models');
const tempRepoDir = path.join(projectRoot, '.tmp-llama-repo');

console.log('--- Llama-cpp-gateway Downloader ---');

// 1. Create target directories
if (!fs.existsSync(binDir)) {
  fs.mkdirSync(binDir, { recursive: true });
}
if (!fs.existsSync(modelsDir)) {
  fs.mkdirSync(modelsDir, { recursive: true });
}

// 2. Clone the repo shallowly to get the latest dist/universal
console.log('Cloning herrbasan/llama-cpp-gateway (shallow)...');
try {
  if (fs.existsSync(tempRepoDir)) {
    fs.rmSync(tempRepoDir, { recursive: true, force: true });
  }
  execSync('git clone --depth 1 https://github.com/herrbasan/llama-cpp-gateway.git .tmp-llama-repo', {
    cwd: projectRoot,
    stdio: 'inherit'
  });
} catch (err) {
  console.error('Failed to clone repository:', err.message);
  process.exit(1);
}

// 3. Copy files from dist/universal to bin/llama
console.log('Copying binaries to bin/llama...');
const sourceDir = path.join(tempRepoDir, 'dist', 'universal');

if (!fs.existsSync(sourceDir)) {
  console.error(`Source directory not found: ${sourceDir}`);
  process.exit(1);
}

function copyDirectorySync(src, dest) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (let entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (!fs.existsSync(destPath)) {
        fs.mkdirSync(destPath);
      }
      copyDirectorySync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

try {
  copyDirectorySync(sourceDir, binDir);
  console.log('Binaries copied successfully!');
} catch (err) {
  console.error('Failed to copy files:', err.message);
  process.exit(1);
}

// 4. Cleanup
console.log('Cleaning up temporary files...');
try {
  fs.rmSync(tempRepoDir, { recursive: true, force: true });
} catch (err) {
  console.warn('Failed to clean up temp dir. You may need to delete .tmp-llama-repo manually.');
}

console.log('\n--- Setup Complete ---');
console.log(`Llama server binaries are installed in: ${binDir}`);
console.log('\nIMPORTANT: You still need to download the embedding model!');
console.log('Please place your model here:');
console.log(`  ${path.join(modelsDir, 'nomic-embed-text-v1.5.Q5_K_M.gguf')}`);
