'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatClient } = require('../src/llm');

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('chat client binds requests to the discovered model digest', async () => {
  const calls = [];
  const client = createChatClient({
    baseUrl: 'http://ollama.test/',
    model: 'qwen36-nothink',
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/api/tags')) return response(200, { models: [{ name: 'qwen36-nothink:latest', digest: 'abc123' }] });
      return response(200, { message: { role: 'assistant', content: '{"ok":true}' }, done: true });
    },
  });

  assert.equal(await client.getModelIdentity(), 'ollama:qwen36-nothink:latest@abc123');
  assert.equal(await client.chatJSON('system', 'user'), '{"ok":true}');
  assert.equal(calls[1].url, 'http://ollama.test/api/chat');
  assert.deepEqual(JSON.parse(calls[1].options.body).messages, [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'user' },
  ]);
});

test('chat client rejects a missing configured chat model and digest', async () => {
  const absent = createChatClient({
    model: 'qwen36-nothink',
    fetchFn: async () => response(200, { models: [{ name: 'other:latest', digest: 'abc' }] }),
  });
  await assert.rejects(absent.getModelIdentity(), /configured chat model not present/);

  const digestless = createChatClient({
    model: 'qwen36-nothink',
    fetchFn: async () => response(200, { models: [{ name: 'qwen36-nothink:latest' }] }),
  });
  await assert.rejects(digestless.getModelIdentity(), /chat model digest missing/);
});

test('chat client rejects malformed chat payloads', async () => {
  const client = createChatClient({ fetchFn: async () => response(200, { message: {} }) });
  await assert.rejects(client.chatJSON('system', 'user'), /invalid payload/);
});

test('chat client aborts requests on timeout', async () => {
  const client = createChatClient({
    timeoutMs: 5,
    fetchFn: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason));
    }),
  });
  await assert.rejects(client.chatJSON('system', 'user'), /timed out/);
});
