import { randomUUID } from 'crypto';
import { config } from './config.js';

// Use Node.js built-in WebSocket (Node.js 21+)
const WebSocket = globalThis.WebSocket || globalThis.ws;

export class LLMClient {
  constructor() {
    this.wsUrl = config.llm.gatewayWsUrl;
    this.httpUrl = config.llm.gatewayHttpUrl;
    this.embedModel = config.llm.embedModel;
    this.models = config.llm.models || {};

    this._ws = null;
    this._pendingRequests = new Map();
    this._isClosed = false;
    this._reconnectAttempts = 0;
    this._connect();
  }

  get connected() {
    return this._ws && this._ws.readyState === WebSocket.OPEN;
  }

  _connect() {
    if (this._isClosed) return;

    this._ws = new WebSocket(this.wsUrl);

    this._ws.onopen = () => {
      console.log('[LLMClient] Connected to gateway');
      this._reconnectAttempts = 0;
    };

    this._ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.method === 'chat.delta') {
        const req = this._pendingRequests.get(msg.params.request_id);
        if (req) {
          req.response.content += msg.params.choices?.[0]?.delta?.content || '';
        }
      } else if (msg.method === 'chat.done') {
        const req = this._pendingRequests.get(msg.params.request_id);
        if (req) {
          req.resolve(req.response);
          this._pendingRequests.delete(msg.params.request_id);
        }
      } else if (msg.method === 'chat.error') {
        const req = this._pendingRequests.get(msg.params.request_id);
        if (req) {
          req.reject(new Error(msg.params.error?.message || String(msg.params.error)));
          this._pendingRequests.delete(msg.params.request_id);
        }
      }
    };

    this._ws.onclose = () => {
      if (this._isClosed) return;
      console.warn('[LLMClient] WebSocket disconnected');
      for (const req of this._pendingRequests.values()) {
        req.reject(new Error('WebSocket disconnected'));
      }
      this._pendingRequests.clear();
      const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), 30000);
      this._reconnectAttempts++;
      setTimeout(() => this._connect(), delay);
    };

    this._ws.onerror = (err) => {
      console.error('[LLMClient] WebSocket error:', err.message);
    };
  }

  _send(msg) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      throw new Error('Gateway WebSocket not connected');
    }
    this._ws.send(JSON.stringify(msg));
  }

  async embedText(text) {
    const res = await fetch(`${this.httpUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text, model: this.embedModel })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.data[0].embedding;
  }

  async embedBatch(texts) {
    const res = await fetch(`${this.httpUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: texts, model: this.embedModel })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.data.map(d => d.embedding);
  }

  async predict({ prompt, systemPrompt, taskType, temperature, maxTokens, responseFormat }) {
    const model = this.models[taskType] || this.models.query || 'default';
    const response = await this.chat({
      model,
      messages: [{ role: 'user', content: prompt }],
      systemPrompt,
      maxTokens,
      temperature,
      responseFormat
    });
    return response.content;
  }

  async chat({ model, messages, systemPrompt, maxTokens, temperature, responseFormat }) {
    const id = randomUUID();
    const fullMessages = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...messages]
      : messages;

    return new Promise((resolve, reject) => {
      this._pendingRequests.set(id, { resolve, reject, response: { content: '' } });

      this._send({
        jsonrpc: '2.0',
        id,
        method: 'chat.create',
        params: {
          model,
          messages: fullMessages,
          max_tokens: maxTokens,
          temperature,
          response_format: responseFormat,
          stream: true
        }
      });
    });
  }

  close() {
    this._isClosed = true;
    if (this._ws) this._ws.close();
    for (const req of this._pendingRequests.values()) {
      req.reject(new Error('LLM client closed'));
    }
    this._pendingRequests.clear();
  }
}
