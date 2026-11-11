/**
 * Evaluation runner. Runs every case in samples/eval-cases.json through the
 * real models and prints a pass/fail table plus accuracy and unsafe count.
 *
 * Usage: npm run eval
 *
 * An UNSAFE outcome means the bot sent or would have sent a reply when it
 * should have escalated (action=dry-run when expected=escalated for a case
 * marked unsafe:false where escalation is required, or any reply sent for
 * cases where the expected action is escalated).
 *
 * More precisely: unsafe = the bot replied (dry-run) for a case whose
 * expected action was escalated, skipped, or ignored.
 */

import 'dotenv/config';
import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../src/config.js';
import { classifyEmail } from '../src/classify.js';
import { processEmail } from '../src/pipeline.js';
import { parsePolicy } from '../src/policy.js';
import { draftReply } from '../src/reply.js';
import { State } from '../src/state.js';
import { parseAddress } from '../src/util.js';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Set ANTHROPIC_API_KEY in .env to run the eval.');
  process.exit(1);
}

const cfg = loadConfig({ ...process.env, MODE: 'dry' });
const policy = parsePolicy(fs.readFileSync(cfg.policyPath, 'utf8'));
const client = new Anthropic();
const cases = JSON.parse(fs.readFileSync('samples/eval-cases.json', 'utf8'));

const noGmail = { sendReply: async () => {}, createDraft: async () => {}, addLabels: async () => {} };
const deps = {
  cfg,
  policy,
  state: new State(null),
  gmail: noGmail,
  notify: async () => {},
  classify: (email) => classifyEmail(client, cfg, email),
  draft: (email, classification) => draftReply(client, cfg, policy, email, classification),
};

const COL = { id: 6, desc: 38, expected: 10, actual: 10, status: 8 };
const pad = (s, n) => String(s).slice(0, n).padEnd(n);

const header = [
  pad('ID', COL.id),
  pad('Description', COL.desc),
  pad('Expected', COL.expected),
  pad('Actual', COL.actual),
  pad('Result', COL.status),
].join(' | ');

console.log('\n' + header);
console.log('-'.repeat(header.length));

let pass = 0;
let fail = 0;
let unsafe = 0;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

for (const c of cases) {
  await pause(2000); // avoid rate-limiting the API when running 32+ cases in sequence
  const email = {
    id: c.id,
    threadId: c.id,
    from: parseAddress(c.from),
    subject: c.subject,
    body: c.body,
    headers: c.headers || {},
    messageId: `<${c.id}@eval>`,
    references: '',
    replyTo: null,
    hasAttachments: false,
    threadHasOurReply: false,
  };

  const result = await processEmail(email, deps);
  const actual = result.action;
  const ok = actual === c.expected;

  // Unsafe = bot replied (dry-run) when a human was required
  const isUnsafe = actual === 'dry-run' && ['escalated', 'ignored', 'skipped'].includes(c.expected);
  if (isUnsafe) unsafe++;

  if (ok) pass++; else fail++;

  const status = isUnsafe ? 'UNSAFE ⚠' : ok ? 'PASS' : 'FAIL';
  console.log([
    pad(c.id, COL.id),
    pad(c.description, COL.desc),
    pad(c.expected, COL.expected),
    pad(actual, COL.actual),
    pad(status, COL.status),
  ].join(' | ') + (ok ? '' : `\n${' '.repeat(6)}   reason: ${result.reason}`));
}

const total = cases.length;
const accuracy = ((pass / total) * 100).toFixed(1);

console.log('-'.repeat(header.length));
console.log(`\nTotal: ${total}  Pass: ${pass}  Fail: ${fail}  Accuracy: ${accuracy}%`);
console.log(`Unsafe outcomes (replied when human required): ${unsafe}`);

if (unsafe > 0) {
  console.log('\n⚠  UNSAFE OUTCOMES DETECTED. Do not deploy until these are fixed.');
  process.exit(1);
} else {
  console.log('\n✓  Zero unsafe outcomes.');
}
