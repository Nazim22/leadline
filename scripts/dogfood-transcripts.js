'use strict';

// Retroactive dogfood: run the claim-obligation detector over Pingu's OWN real Claude
// Code transcripts and measure how many high-risk claims were made WITHOUT supporting
// evidence earlier in the same session. Conservative (session-level support = under-flags),
// so anything it flags is a high-confidence unsupported claim. Answers the go/no-go
// question: "does Leadline catch real unsupported agent claims?" — no live-env risk.
//   node scripts/dogfood-transcripts.js [N-sessions]
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { detectClaims } = require('../src/claims');

const PROJECTS = '/root/.claude/projects';
const N = Number(process.argv[2] || 60);

// tool (name + bash arg text) -> evidence family it provides
function toolEvidenceFamilies(name, input) {
  const fams = new Set();
  const n = String(name || '');
  const cmd = (input && (input.command || input.cmd)) ? String(input.command || input.cmd) : '';
  const q = `${n} ${cmd}`.toLowerCase();
  if (/graphify|code-review-graph|code_callers|code_callees|get_neighbors|query_graph|god_nodes/.test(n)) fams.add('structural');
  if (/gbrain__(query|recall|search|get_page|get_chunks)|gbrain query/.test(q)) fams.add('historical');
  if (n === 'Read' || n === 'Grep' || n === 'Glob') fams.add('repository');
  if (/\b(grep|rg|cat|sed|awk|head|tail|ls|git show|git diff|git log|git status)\b/.test(cmd)) fams.add('repository');
  if (/\b(curl|psql|pct|ssh|gh |systemctl|kubectl|docker ps|health|responding|api\/|nc -z|ss -ltn)\b/.test(cmd)) fams.add('runtime');
  if (/\b(npm test|npm run test|pytest|node --test|go test|cargo test|npm run bench)\b/.test(cmd)) fams.add('runtime');
  return fams;
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
  return '';
}
function toolUses(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b && b.type === 'tool_use').map((b) => ({ name: b.name, input: b.input }));
}

let files = execSync(`find ${PROJECTS} -maxdepth 2 -name '*.jsonl' -not -path '*/subagents/*' -printf '%T@ %p\\n' 2>/dev/null | sort -rn | head -${N} | awk '{print $2}'`)
  .toString().trim().split('\n').filter(Boolean);

let sessions = 0, totalClaims = 0, supported = 0, unsupported = 0;
const byFamily = {}; const examples = [];

const WINDOW = 6; // claim is "supported" only if matching evidence appeared within the last WINDOW assistant turns

for (const f of files) {
  sessions += 1;
  const lastEvidenceTurn = {}; // family -> assistant-turn index of most recent supporting evidence
  let turn = 0;
  let lines;
  try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch { continue; }
  for (const line of lines) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'assistant' && e.message) {
      turn += 1;
      const content = e.message.content;
      // claims in this turn are judged against evidence seen in the recent window BEFORE this turn
      for (const claim of detectClaims(extractText(content))) {
        totalClaims += 1;
        byFamily[claim.family] = byFamily[claim.family] || { total: 0, unsupported: 0 };
        byFamily[claim.family].total += 1;
        const last = lastEvidenceTurn[claim.family];
        if (last != null && (turn - last) <= WINDOW) { supported += 1; }
        else {
          unsupported += 1; byFamily[claim.family].unsupported += 1;
          if (examples.length < 12) examples.push(`[${claim.family}/${claim.id}] "${claim.claim.trim()}"`);
        }
      }
      // then record evidence this turn's tool calls provide
      for (const t of toolUses(content)) for (const fam of toolEvidenceFamilies(t.name, t.input)) lastEvidenceTurn[fam] = turn;
    }
  }
}

console.log(`\nDOGFOOD — Pingu's own transcripts (${sessions} recent sessions)`);
console.log(`high-risk claims detected: ${totalClaims}`);
console.log(`  supported (evidence earlier in session): ${supported} (${totalClaims ? (100 * supported / totalClaims).toFixed(1) : 0}%)`);
console.log(`  UNSUPPORTED (no matching evidence): ${unsupported} (${totalClaims ? (100 * unsupported / totalClaims).toFixed(1) : 0}%)`);
console.log('\nby family (total / unsupported):');
for (const [fam, s] of Object.entries(byFamily)) console.log(`  ${fam.padEnd(11)} ${s.total} / ${s.unsupported}`);
console.log('\nsample unsupported claims Leadline would have flagged:');
for (const ex of examples) console.log(`  - ${ex}`);
