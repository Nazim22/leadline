'use strict';

// Measure the LLM-assisted claim detector on REAL transcripts: of the keyword-detected
// claim candidates, how many does the LLM CONFIRM as genuine evidence-requiring claims
// vs REJECT as conversational/quoted (the false-positives the keyword version couldn't
// filter)? Answers: does the reframed detector actually solve the FP problem on real data?
//   node scripts/dogfood-llm-detector.js [max-turns]
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createChatClient } = require('../src/llm');
const { createClaimObligationDetector } = require('../src/claim-detector');
const { detectClaims } = require('../src/claims');

const PROJECTS = '/root/.claude/projects';
const MAX = Number(process.argv[2] || 50);

const extractText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '');

(async () => {
  const files = execFileSync('bash', ['-c',
    `find ${PROJECTS} -maxdepth 2 -name '*.jsonl' -not -path '*/subagents/*' -printf '%T@ %p\\n' | sort -rn | head -40 | awk '{print $2}'`,
  ]).toString().trim().split('\n').filter(Boolean);

  // collect assistant turns that have >=1 keyword candidate
  const turns = [];
  for (const f of files) {
    let lines; try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch { continue; }
    for (const line of lines) {
      if (!line.trim() || turns.length >= MAX) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.type === 'assistant' && e.message) {
        const t = extractText(e.message.content);
        if (t && detectClaims(t).length) turns.push(t);
      }
    }
    if (turns.length >= MAX) break;
  }

  const client = createChatClient();
  const modelIdentity = await client.getModelIdentity();
  const detector = await createClaimObligationDetector({ llmClient: client, expectedModelIdentity: modelIdentity });

  let candidates = 0, confirmed = 0, rejected = 0, errors = 0;
  const confirmedEx = [], rejectedEx = [];
  let done = 0;
  for (const t of turns) {
    let r; try { r = await detector.detect(t); } catch { errors += 1; continue; }
    if (r.status !== 'ok') { errors += 1; continue; }
    candidates += r.candidate_count;
    confirmed += r.obligations.length;
    rejected += r.rejected.length;
    for (const o of r.obligations) if (confirmedEx.length < 8) confirmedEx.push(`[${o.family}] "${o.claim.trim().slice(0, 70)}" (entity: ${o.entity})`);
    for (const x of r.rejected) if (rejectedEx.length < 8) rejectedEx.push(`"${(x.claim || '').trim().slice(0, 70)}"`);
    if (++done % 10 === 0) process.stderr.write(`  ${done}/${turns.length}\n`);
  }

  console.log(`\nLLM-ASSISTED DETECTOR on real transcripts (${done} candidate-bearing turns, ${errors} errors)`);
  console.log(`  keyword candidates: ${candidates}`);
  console.log(`  → CONFIRMED as real claims (need receipt): ${confirmed} (${candidates ? (100 * confirmed / candidates).toFixed(1) : 0}%)`);
  console.log(`  → REJECTED as conversational/quoted (false positives filtered): ${rejected} (${candidates ? (100 * rejected / candidates).toFixed(1) : 0}%)`);
  console.log('\n  sample CONFIRMED (real claims Leadline would require evidence for):');
  confirmedEx.forEach((e) => console.log(`    ✓ ${e}`));
  console.log('\n  sample REJECTED (the false positives the keyword version wrongly flagged):');
  rejectedEx.forEach((e) => console.log(`    ✗ ${e}`));
})();
