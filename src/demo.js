import 'dotenv/config';
import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from './config.js';
import { classifyEmail } from './classify.js';
import { processEmail } from './pipeline.js';
import { parsePolicy } from './policy.js';
import { draftReply } from './reply.js';
import { State } from './state.js';
import { parseAddress } from './util.js';

// Runs the REAL classifier + reply model + safety guards over sample emails.
// No Gmail needed, nothing is sent. Good for testing a new policy and for demos.

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Set ANTHROPIC_API_KEY in .env to run the demo.');
  process.exit(1);
}

const cfg = loadConfig({ ...process.env, MODE: 'dry' });
const policy = parsePolicy(fs.readFileSync(cfg.policyPath, 'utf8'));
const client = new Anthropic();
const samples = JSON.parse(fs.readFileSync('samples/emails.json', 'utf8'));

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

const tally = {};
const indent = (text) => text.split('\n').map((l) => `      ${l}`).join('\n');

for (const [i, s] of samples.entries()) {
  const email = {
    id: s.id,
    threadId: s.id,
    from: parseAddress(s.from),
    subject: s.subject,
    body: s.body,
    headers: s.headers || {},
    messageId: `<${s.id}@demo>`,
    references: '',
    threadHasOurReply: false,
  };

  const result = await processEmail(email, deps);
  tally[result.action] = (tally[result.action] || 0) + 1;

  const label = result.action === 'dry-run' ? 'WOULD REPLY' : result.action.toUpperCase();
  console.log(`\n[${i + 1}/${samples.length}] ${email.subject}`);
  console.log(`   ${label} in ${(result.ms / 1000).toFixed(1)}s. ${result.reason}`);
  if (result.action === 'dry-run') console.log(indent(result.body));
  if (result.action === 'escalated' && result.draft?.reply) {
    console.log('   Blocked draft (not sent):');
    console.log(indent(result.draft.reply));
  }
}

console.log('\nSummary:', tally);
