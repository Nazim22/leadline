'use strict';

// Local LLM client — qwen via Ollama on the host GPU. No API key, prompts never leave the box.
const OLLAMA = process.env.LEADLINE_OLLAMA_URL || 'http://127.0.0.1:11434';
const CHAT_MODEL = process.env.LEADLINE_LLM_MODEL || 'qwen36-nothink';

async function chatJSON(system, user, { model = CHAT_MODEL, temperature = 0 } = {}) {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      format: 'json',
      options: { temperature },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`llm chat failed: HTTP ${res.status}`);
  const data = await res.json();
  return data.message?.content ?? '';
}

module.exports = { chatJSON, CHAT_MODEL, OLLAMA };
