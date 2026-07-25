'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEmbedClient } = require('../src/embed');

function response(body, ok = true, status = 200) {
  return { ok, status, async json() { return body; } };
}

test('embed client validates vector count, dimensions, and finite values', async () => {
  const good = createEmbedClient({
    baseUrl: 'http://ollama', model: 'bge-m3', timeoutMs: 100,
    fetchFn: async () => response({ embeddings: [[1, 2], [3, 4]] }),
  });
  assert.deepEqual(await good.embed(['a', 'b']), [[1, 2], [3, 4]]);

  const wrongCount = createEmbedClient({
    fetchFn: async () => response({ embeddings: [[1, 2]] }), timeoutMs: 100,
  });
  await assert.rejects(wrongCount.embed(['a', 'b']), /count mismatch/);

  const badDimension = createEmbedClient({
    fetchFn: async () => response({ embeddings: [[1, 2], [3]] }), timeoutMs: 100,
  });
  await assert.rejects(badDimension.embed(['a', 'b']), /dimension/);

  const nonFinite = createEmbedClient({
    fetchFn: async () => response({ embeddings: [[1, Number.NaN]] }), timeoutMs: 100,
  });
  await assert.rejects(nonFinite.embed(['a']), /finite/);
});

test('model identity is bound to the exact Ollama digest', async () => {
  const client = createEmbedClient({
    baseUrl: 'http://ollama', model: 'bge-m3', timeoutMs: 100,
    fetchFn: async (url) => {
      assert.match(url, /api\/tags$/);
      return response({ models: [{ name: 'bge-m3:latest', digest: 'sha256:abc' }] });
    },
  });
  assert.equal(await client.getModelIdentity(), 'ollama:bge-m3:latest@sha256:abc');
  assert.equal(await client.available(), true);
});

test('availability is false when configured model is absent', async () => {
  const client = createEmbedClient({
    model: 'bge-m3', timeoutMs: 100,
    fetchFn: async () => response({ models: [{ name: 'other:latest', digest: 'sha256:def' }] }),
  });
  assert.equal(await client.available(), false);
  await assert.rejects(client.getModelIdentity(), /not present/);
});

test('requests abort on timeout', async () => {
  const client = createEmbedClient({
    timeoutMs: 5,
    fetchFn: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason));
    }),
  });
  await assert.rejects(client.embed(['a']), /timed out|TimeoutError/i);
});
