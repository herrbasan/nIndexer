import { config } from './config.js';
import { getLogger } from './utils/logger.js';
import { startLlamaServer, stopLlamaServer } from './utils/llama-spawner.js';

const logger = getLogger();

export class LLMClient {
  constructor() {
    this._initialized = false;
    
    // Concurrency limiter for embeddings
    const limit = config.llm.maxConcurrentRequests || 100;
    this._maxConcurrency = limit;
    this._activeRequests = 0;
    this._queue = [];

    this._embedCircuitOpen = false;
    this._embedFailCount = 0;
    this._embedCircuitResetAt = 0;

    this._initPromise = this._connect();
  }

  async _connect() {
    if (config.llm.provider === 'local') {
      const started = await startLlamaServer();
      if (!started) {
        logger.warn('Failed or skipped booting local Llama. Embeddings may fail if no fallback is available.', {}, 'LLMClient');
      }
      this.httpUrl = `http://localhost:${config.llama.port}`;
    } else if (config.llm.provider === 'remote' && config.llm.remoteFallback) {
      this.httpUrl = config.llm.remoteFallback;
    } else {
      this.httpUrl = `http://localhost:${config.llama.port}`; // Assume something is running externally on this port
    }
    
    this._initialized = true;
  }

  async waitReady() {
    if (!this._initialized) await this._initPromise;
  }

  get embedAvailable() {
    if (!this._embedCircuitOpen) return true;
    if (Date.now() >= this._embedCircuitResetAt) {
      this._embedCircuitOpen = false;
      this._embedFailCount = 0;
      logger.info(`Embedding circuit breaker reset`, {}, 'LLMClient');
      return true;
    }
    return false;
  }

  _tripEmbedCircuit() {
    this._embedFailCount++;
    if (this._embedFailCount >= 3) {
      this._embedCircuitOpen = true;
      this._embedCircuitResetAt = Date.now() + 60000;
      logger.warn(`Embedding circuit breaker tripped`, {
        failCount: this._embedFailCount,
        retryAfterMs: 60000
      }, 'LLMClient');
    }
  }

  // Generic HTTP Fetcher for OpenAI schema
  async _fetchEmbeddings(inputData) {
    if (!this.embedAvailable) throw new Error('Embedding service unavailable (circuit breaker open)');
    await this.waitReady();

    try {
      const res = await fetch(`${this.httpUrl}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
           input: inputData, 
           model: 'local-model' // Most local LLMs ignore this or use loaded model
        })
      });
      
      if (!res.ok) {
        this._tripEmbedCircuit();
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      
      const data = await res.json();
      this._embedFailCount = 0;
      return data;
    } catch (err) {
      if (err.message !== 'Embedding service unavailable (circuit breaker open)') {
        logger.error('Failed to fetch embeddings', err, {}, 'LLMClient');
        this._tripEmbedCircuit();
      }
      throw err;
    }
  }

  // Concurrency Queue Executor
  async _enqueue(taskFn) {
    if (this._activeRequests >= this._maxConcurrency) {
      await new Promise(resolve => this._queue.push(resolve));
    }
    
    this._activeRequests++;
    try {
      return await taskFn();
    } finally {
      this._activeRequests--;
      if (this._queue.length > 0) {
         const next = this._queue.shift();
         next(); // Unblock the next queued task
      }
    }
  }

  async embedText(text) {
     return this._enqueue(async () => {
        const data = await this._fetchEmbeddings(text);
        if (!data?.data?.[0]?.embedding) throw new Error('Invalid embedding response format');
        return data.data[0].embedding;
     });
  }

  async embedBatch(texts) {
    return this._enqueue(async () => {
        const data = await this._fetchEmbeddings(texts);
        if (!data?.data || data.data.length !== texts.length) {
            throw new Error('Invalid batch embedding response length');
        }
        return data.data.map(d => d.embedding);
    });
  }

  async predict({ prompt, systemPrompt, taskType, temperature, maxTokens, responseFormat }) {
     throw new Error("Chat APIs via Gateway have been decoupled. This feature requires standard OpenAI REST implementation.");
  }

  async chat({ task, messages, systemPrompt, maxTokens, temperature, responseFormat }) {
     throw new Error("Chat APIs via Gateway have been decoupled. This feature requires standard OpenAI REST implementation.");
  }

  close() {
    this._queue = []; // Clear pending requests
    if (config.llm.provider === 'local') {
      stopLlamaServer();
    }
  }
}
