import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const modelsDir = path.join(projectRoot, 'bin', 'llama', 'models');

// Jina Embeddings V2 Base Code - Specifically trained on code, 8192 context, 768 dimensions.
// Note: We use a community quantized GGUF since it's required for llama-cpp-gateway.
const MODEL_URL = 'https://huggingface.co/second-state/Jina-Embeddings-v2-base-code-GGUF/resolve/main/jina-embeddings-v2-base-code-Q5_K_M.gguf';
const DEST_FILE = path.join(modelsDir, 'jina-embeddings-v2-base-code-Q5_K_M.gguf');

if (!fs.existsSync(modelsDir)) {
  fs.mkdirSync(modelsDir, { recursive: true });
}

console.log(`Downloading Jina Embeddings V2 Base Code (GGUF)...`);
console.log(`Target: ${DEST_FILE}`);

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        // Handle redirects (ensure absolute URL)
        const redirectUrl = new URL(response.headers.location, url).href;
        return download(redirectUrl, dest).then(resolve).catch(reject);
      }
      
      if (response.statusCode !== 200) {
        return reject(new Error(`Failed to get '${url}' (${response.statusCode})`));
      }

      const fileStream = fs.createWriteStream(dest);
      const totalBytes = parseInt(response.headers['content-length'], 10);
      let downloadedBytes = 0;

      response.pipe(fileStream);

      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        const percent = ((downloadedBytes / totalBytes) * 100).toFixed(1);
        process.stdout.write(`\rProgress: ${percent}% (${(downloadedBytes / 1024 / 1024).toFixed(2)} MB)`);
      });

      fileStream.on('finish', () => {
        process.stdout.write('\n');
        fileStream.close();
        resolve();
      });

      fileStream.on('error', (err) => {
        fs.unlink(dest, () => reject(err));
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => reject(err));
    });
  });
}

download(MODEL_URL, DEST_FILE)
  .then(() => {
    console.log('Model downloaded successfully!');
    console.log('You can now start nIndexer: node src/server.js');
  })
  .catch(err => {
    console.error('\nDownload failed:', err.message);
    process.exit(1);
  });
