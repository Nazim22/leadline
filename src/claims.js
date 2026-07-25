'use strict';

// Claim-obligation detector — the heart of the reframed product. Finds high-risk
// CLAIMS in an agent's output that require evidence, and the evidence family each needs.
// Detects around the CLAIM (not the user prompt) — safer and more precise. High-precision
// patterns only; a miss = no obligation (never over-flag).

const OBLIGATIONS = [
  {
    id: 'runtime-live', family: 'runtime', evidence: 'runtime probe',
    patterns: [
      /\bis (?:now )?(?:live|deployed|running|up|responding|online|healthy)\b/i,
      /\b(?:deployed|restarted|redeployed|rebooted) (?:successfully|it|the|and)\b/i,
      /\bservice is (?:up|healthy|running|back)\b/i,
      /\bendpoint (?:is )?responding\b/i,
    ],
  },
  {
    id: 'test-pass', family: 'runtime', evidence: 'test/CI run',
    patterns: [
      /\b(?:tests?|suite|ci|build) (?:pass|passed|passing|are green|succeeded|is green)\b/i,
      /\b\d+\/\d+ (?:tests? )?(?:pass|passing)\b/i,
      /\bverified (?:working|it works)\b/i,
      /\bconfirmed working\b/i,
    ],
  },
  {
    id: 'repo-state', family: 'repository', evidence: 'current repository read',
    patterns: [
      /\bthe (?:file|code|function|config|line) (?:says|does|contains|is set to|reads)\b/i,
      /\bline \d+ (?:says|is|contains|reads)\b/i,
      /\b(?:the )?bug is (?:in|at|caused by)\b/i,
      /\bi (?:fixed|patched|corrected) (?:the|this|it|a)\b/i,
    ],
  },
  {
    id: 'hist-decided', family: 'historical', evidence: 'historical authority (recall)',
    patterns: [
      /\bwe (?:decided|chose|agreed|shipped|already built|previously built)\b/i,
      /\blast session we\b/i,
    ],
  },
  {
    id: 'structural-complete', family: 'structural', evidence: 'structural source (completeness)',
    patterns: [
      /\ball (?:the )?(?:callers|usages|references|consumers) (?:of|are)\b/i,
      /\bnothing else (?:uses|calls|references)\b/i,
      /\bonly \w+ (?:calls|uses|references)\b/i,
    ],
  },
];

function detectClaims(text) {
  if (typeof text !== 'string' || !text) return [];
  const found = [];
  const seen = new Set();
  for (const o of OBLIGATIONS) {
    for (const pattern of o.patterns) {
      const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
      const matcher = new RegExp(pattern.source, flags);
      for (const match of text.matchAll(matcher)) {
        const at = match.index;
        const key = `${o.id}:${at}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({
          at,
          end: at + match[0].length,
          obligationId: o.id,
          value: {
            id: o.id,
            family: o.family,
            evidence: o.evidence,
            claim: text.slice(at, at + 90).replace(/\s+/g, ' '),
            start: at,
            end: at + match[0].length,
          },
        });
      }
    }
  }
  const ordered = found.sort((left, right) => left.at - right.at || right.end - left.end);
  const accepted = [];
  for (const entry of ordered) {
    const overlaps = accepted.some((prior) => (
      prior.obligationId === entry.obligationId && entry.at < prior.end && entry.end > prior.at
    ));
    if (!overlaps) accepted.push(entry);
  }
  return accepted.map((entry) => entry.value);
}

module.exports = { detectClaims, OBLIGATIONS };

// ponytail: self-check runs on `node src/claims.js` — the runnable check behind the logic.
if (require.main === module) {
  const assert = require('node:assert');
  assert.deepStrictEqual(detectClaims('The lambda is live and responding.').map((c) => c.family), ['runtime']);
  assert.deepStrictEqual(detectClaims('37/37 tests pass now.').map((c) => c.id), ['test-pass']);
  assert.deepStrictEqual(detectClaims('I fixed the bug in the handler.').map((c) => c.family), ['repository']);
  assert.deepStrictEqual(detectClaims('we decided to use Neon last week').map((c) => c.family), ['historical']);
  assert.strictEqual(detectClaims('let me look into this').length, 0);
  console.log('claims.js self-check OK');
}
