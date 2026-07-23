'use strict';

// Local embedding client — bge-m3 via Ollama on the host GPU. No API key, no cloud.
const OLLAMA = process.env.LEADLINE_OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL = process.env.LEADLINE_EMBED_MODEL || 'bge-m3';

async function embed(inputs) {
  const arr = Array.isArray(inputs) ? inputs : [inputs];
  const res = await fetch(`${OLLAMA}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: arr }),
  });
  if (!res.ok) throw new Error(`embed failed: HTTP ${res.status}`);
  const data = await res.json();
  if (!data.embeddings || !data.embeddings.length) throw new Error('embed returned no vectors');
  return data.embeddings;
}

// ponytail: reachability probe so the planner can fail open when Ollama is down.
async function embedAvailable() {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

module.exports = { embed, embedAvailable, MODEL, OLLAMA };
