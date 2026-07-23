'use strict';

const DEFAULT_OLLAMA = process.env.LEADLINE_OLLAMA_URL || 'http://127.0.0.1:11434';
const DEFAULT_MODEL = process.env.LEADLINE_LLM_MODEL || 'qwen36-nothink';
const DEFAULT_TIMEOUT_MS = Number(process.env.LEADLINE_LLM_TIMEOUT_MS || 15_000);

function normalizeModelName(name) {
  return name.includes(':') ? name : `${name}:latest`;
}

function createChatClient({
  baseUrl = DEFAULT_OLLAMA,
  model = DEFAULT_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchFn = globalThis.fetch,
} = {}) {
  if (typeof fetchFn !== 'function') throw new TypeError('fetchFn must be a function');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('timeoutMs must be a positive integer');
  if (typeof model !== 'string' || model.length === 0) throw new TypeError('model must be a non-empty string');
  const endpoint = String(baseUrl).replace(/\/+$/u, '');
  const configuredModel = model;

  async function request(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`LLM request timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    try {
      return await fetchFn(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function getModelIdentity() {
    const response = await request(`${endpoint}/api/tags`, { method: 'GET' });
    if (!response.ok) throw new Error(`chat model discovery failed: HTTP ${response.status}`);
    const data = await response.json();
    if (!data || !Array.isArray(data.models)) throw new Error('chat model discovery returned invalid payload');
    const wanted = normalizeModelName(configuredModel);
    const found = data.models.find((candidate) => (
      normalizeModelName(String(candidate.name || candidate.model || '')) === wanted
    ));
    if (!found) throw new Error(`configured chat model not present: ${wanted}`);
    if (typeof found.digest !== 'string' || found.digest.length === 0) {
      throw new Error(`chat model digest missing: ${wanted}`);
    }
    return `ollama:${wanted}@${found.digest}`;
  }

  async function chatJSON(system, user, { temperature = 0 } = {}) {
    if (typeof system !== 'string' || system.length === 0) throw new TypeError('system must be a non-empty string');
    if (typeof user !== 'string' || user.length === 0) throw new TypeError('user must be a non-empty string');
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw new RangeError('temperature must be finite and between 0 and 2');
    }
    const response = await request(`${endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: configuredModel,
        stream: false,
        format: 'json',
        options: { temperature },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!response.ok) throw new Error(`llm chat failed: HTTP ${response.status}`);
    const data = await response.json();
    if (!data || !data.message || data.message.role !== 'assistant'
        || typeof data.message.content !== 'string' || data.message.content.length === 0) {
      throw new Error('llm chat returned invalid payload');
    }
    return data.message.content;
  }

  return Object.freeze({
    baseUrl: endpoint,
    chatJSON,
    getModelIdentity,
    model: configuredModel,
    timeoutMs,
  });
}

const defaultClient = createChatClient();

module.exports = {
  CHAT_MODEL: DEFAULT_MODEL,
  OLLAMA: DEFAULT_OLLAMA,
  createChatClient,
  chatJSON: defaultClient.chatJSON,
  getChatModelIdentity: defaultClient.getModelIdentity,
};
