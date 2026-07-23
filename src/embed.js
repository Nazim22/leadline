'use strict';

const DEFAULT_OLLAMA = process.env.LEADLINE_OLLAMA_URL || 'http://127.0.0.1:11434';
const DEFAULT_MODEL = process.env.LEADLINE_EMBED_MODEL || 'bge-m3';
const DEFAULT_TIMEOUT_MS = Number(process.env.LEADLINE_EMBED_TIMEOUT_MS || 10_000);

function validateVectors(vectors, expectedCount) {
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) {
    throw new Error(`embedding count mismatch: expected ${expectedCount}, got ${Array.isArray(vectors) ? vectors.length : 'non-array'}`);
  }
  let dimension = null;
  vectors.forEach((vector, index) => {
    if (!Array.isArray(vector) || vector.length === 0) throw new TypeError(`embedding ${index} must be a non-empty vector`);
    if (dimension == null) dimension = vector.length;
    if (vector.length !== dimension) throw new RangeError(`embedding ${index} dimension ${vector.length} != ${dimension}`);
    if (!vector.every(Number.isFinite)) throw new TypeError(`embedding ${index} must contain only finite numbers`);
  });
  return vectors;
}

function normalizeModelName(name) {
  return name.includes(':') ? name : `${name}:latest`;
}

function createEmbedClient({
  baseUrl = DEFAULT_OLLAMA,
  model = DEFAULT_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchFn = globalThis.fetch,
} = {}) {
  if (typeof fetchFn !== 'function') throw new TypeError('fetchFn must be a function');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('timeoutMs must be a positive integer');
  const endpoint = String(baseUrl).replace(/\/+$/u, '');
  const configuredModel = String(model);

  async function request(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`embedding request timed out after ${timeoutMs}ms`)), timeoutMs);
    try {
      return await fetchFn(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function embed(inputs) {
    const values = Array.isArray(inputs) ? inputs : [inputs];
    if (values.length === 0 || !values.every((value) => typeof value === 'string' && value.length > 0)) {
      throw new TypeError('embed inputs must be one or more non-empty strings');
    }
    const response = await request(`${endpoint}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: configuredModel, input: values }),
    });
    if (!response.ok) throw new Error(`embed failed: HTTP ${response.status}`);
    const data = await response.json();
    return validateVectors(data.embeddings, values.length);
  }

  async function getModelIdentity() {
    const response = await request(`${endpoint}/api/tags`, { method: 'GET' });
    if (!response.ok) throw new Error(`model discovery failed: HTTP ${response.status}`);
    const data = await response.json();
    if (!data || !Array.isArray(data.models)) throw new Error('model discovery returned invalid payload');
    const wanted = normalizeModelName(configuredModel);
    const found = data.models.find((candidate) => normalizeModelName(String(candidate.name || candidate.model || '')) === wanted);
    if (!found) throw new Error(`configured embedding model not present: ${wanted}`);
    if (typeof found.digest !== 'string' || found.digest.length === 0) throw new Error(`embedding model digest missing: ${wanted}`);
    return `ollama:${wanted}@${found.digest}`;
  }

  async function available() {
    try {
      await getModelIdentity();
      return true;
    } catch {
      return false;
    }
  }

  return Object.freeze({
    available,
    baseUrl: endpoint,
    embed,
    getModelIdentity,
    model: configuredModel,
    timeoutMs,
  });
}

const defaultClient = createEmbedClient();

module.exports = {
  MODEL: DEFAULT_MODEL,
  OLLAMA: DEFAULT_OLLAMA,
  createEmbedClient,
  embed: defaultClient.embed,
  embedAvailable: defaultClient.available,
  getEmbedModelIdentity: defaultClient.getModelIdentity,
  validateVectors,
};
