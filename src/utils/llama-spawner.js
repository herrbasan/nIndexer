import os from 'os';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { config } from '../config.js';
import { getLogger } from './logger.js';
import { fileURLToPath } from 'url';

const logger = getLogger();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let llamaProcess = null;
let isShuttingDown = false;

export async function startLlamaServer() {
  if (llamaProcess) return true; // Already running

  const { port, modelPath, ctxSize } = config.llama;
  
  // Resolve paths relative to project root
  const projectRoot = path.join(__dirname, '..', '..');
  
  const binExt = os.platform() === 'win32' ? '.exe' : '';
  const binName = `llama-server${binExt}`;
  
  const binPath = path.join(projectRoot, 'bin', 'llama', binName);
  const resolvedModelPath = path.isAbsolute(modelPath) ? modelPath : path.join(projectRoot, modelPath);

  logger.info(`Starting local Llama Server`, { binPath, modelPath: resolvedModelPath, port }, 'LlamaSpawner');

  if (!fs.existsSync(binPath)) {
    logger.warn(`Local Llama Server binary not found. Skipping spawner...`, { binPath }, 'LlamaSpawner');
    return false;
  }

  if (!fs.existsSync(resolvedModelPath)) {
    logger.warn(`Llama model not found. Cannot start local embedding server.`, { resolvedModelPath }, 'LlamaSpawner');
    return false;
  }

  return new Promise((resolve) => {
    const args = [
      '-m', resolvedModelPath,
      '--port', port.toString(),
      '-c', ctxSize.toString(),
      '-b', ctxSize.toString(),
      '-ub', ctxSize.toString(),
      '--embedding'
    ];

    llamaProcess = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let isReady = false;

    llamaProcess.stdout.on('data', (data) => {
      const output = data.toString();
      if (!isReady && output.includes('main: server is listening')) {
        isReady = true;
        logger.info(`Llama Server is ready!`, { port }, 'LlamaSpawner');
        resolve(true); 
      }
    });

    llamaProcess.stderr.on('data', (data) => {
      const output = data.toString();
      // llama.cpp often prints readiness to stderr
      if (!isReady && (output.includes('HTTP server listening') || output.includes('main: server is listening') || output.includes('llama server listening') || output.includes('server is listening on'))) {
          isReady = true;
          logger.info(`Llama Server HTTP is ready!`, { port }, 'LlamaSpawner');
          resolve(true);
      }
    });

    llamaProcess.on('close', (code) => {
      if (!isShuttingDown) {
        logger.warn(`Llama Server exited unexpectedly`, { code }, 'LlamaSpawner');
      }
      llamaProcess = null;
      if (!isReady) resolve(false); // Failed to start
    });
    
    llamaProcess.on('error', (err) => {
       logger.error(`Llama Server child process error`, err, {}, 'LlamaSpawner');
       if (!isReady) resolve(false);
    });
  });
}

export function stopLlamaServer() {
  if (!llamaProcess) return;
  isShuttingDown = true;
  logger.info('Stopping local Llama Server...', {}, 'LlamaSpawner');
  llamaProcess.kill('SIGINT');
  
  // Force kill if it doesn't respond
  setTimeout(() => {
    if (llamaProcess) {
      llamaProcess.kill('SIGKILL');
      llamaProcess = null;
    }
  }, 2000).unref();
}

// Ensure process teardown cleans up the GPU memory bound bin
process.on('exit', () => stopLlamaServer());
process.on('SIGINT', () => { stopLlamaServer(); process.exit(); });
process.on('SIGTERM', () => { stopLlamaServer(); process.exit(); });
