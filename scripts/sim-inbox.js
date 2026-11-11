/**
 * Phase 3 — Gmail Inbox Simulation (MOCK)
 *
 * ⚠  NOT VERIFIED AGAINST A REAL GMAIL INBOX — NDA restriction.
 *    Real Gmail OAuth2 credentials are unavailable for this project.
 *    The offline unit tests in test/gmail.test.js cover extractBody and
 *    buildRaw (the only Gmail-specific logic that can be tested without
 *    credentials). Everything below simulates what the live agent would do.
 *
 * What this script shows:
 *   - The inbox polling loop (getUnread → processEmail → label)
 *   - Real AI calls (Anthropic key required) with the actual policy
 *   - All Gmail API calls stubbed with [MOCK] output so the flow is visible
 *   - Realistic email mix: export queries, spam, a legal threat, an auto-reply
 *
 * Usage:
 *   npm run sim          (or: node scripts/sim-inbox.js)
 *
 * To run against a real inbox once credentials exist:
 *   1. npm run auth          (OAuth2 consent flow)
 *   2. npm start             (full live agent)
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

// ─── colour helpers ──────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',   bold: '\x1b[1m',   dim: '\x1b[2m',
  red: '\x1b[31m',    green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m',   cyan: '\x1b[36m',  grey: '\x1b[90m',
  magenta: '\x1b[35m',
};
const c = (code, s) => `${code}${s}${C.reset}`;
const mock = (s) => c(C.grey, `[MOCK] ${s}`);
const indent = (s, n = 6) => s.split('\n').map(l => ' '.repeat(n) + l).join('\n');

// ─── simulated inbox messages ────────────────────────────────────────────────
// These represent a realistic hour of incoming mail for an export team.
const INBOX = [
  {
    id: 'sim-001',
    threadId: 'thread-001',
    from: 'Klaus Müller <k.mueller@import-berlin.de>',
    subject: 'Mindestbestellmenge und Incoterms',
    body: 'Guten Tag, wir sind Importeure in Berlin. Bitte teilen Sie uns Ihre Mindestbestellmenge und die angebotenen Incoterms mit. Vielen Dank.',
    headers: {},
  },
  {
    id: 'sim-002',
    threadId: 'thread-002',
    from: 'noreply@trade-bulletin.com',
    subject: 'Weekly Export Intelligence Digest — Issue 211',
    body: 'Your curated export market roundup. Click to read.',
    headers: { 'list-unsubscribe': '<mailto:unsub@trade-bulletin.com>' },
  },
  {
    id: 'sim-003',
    threadId: 'thread-003',
    from: 'Sandra Lee <sandra@retail-sg.com>',
    subject: 'New distributor enquiry + sample request',
    body: 'Hello, we are a retail chain based in Singapore interested in becoming a distributor. What is your MOQ and sample cost? Also, could you offer a 10% introductory discount?',
    headers: {},
  },
  {
    id: 'sim-004',
    threadId: 'thread-004',
    from: 'legal@crawford-partners.com',
    subject: 'Notice of intended litigation — shipment #4891',
    body: 'We represent FastTrade GmbH. You have 72 hours to respond regarding the outstanding dispute on shipment #4891 or we will proceed with legal action.',
    headers: {},
  },
  {
    id: 'sim-005',
    threadId: 'thread-005',
    from: 'Omar Hassan <omar@nile-traders.eg>',
    subject: 'Export enquiry from Egypt',
    body: 'مرحباً، نحن شركة استيراد في القاهرة. هل يمكنكم إرسال قائمة الأسعار وشروط الشحن؟ شكراً جزيلاً.',
    headers: {},
  },
  {
    id: 'sim-006',
    threadId: 'thread-005',  // same thread as sim-005 — already replied
    from: 'Omar Hassan <omar@nile-traders.eg>',
    subject: 'Re: Export enquiry from Egypt',
    body: 'Thank you for your reply. One more question: do you ship CIF to Alexandria?',
    headers: {},
  },
  {
    id: 'sim-007',
    threadId: 'thread-007',
    from: 'buyer@company.com',
    subject: 'Out of office: Re: Product samples',
    body: 'I am out of office until 10 November. For urgent matters contact assistant@company.com.',
    headers: { 'auto-submitted': 'auto-replied' },
  },
];

// ─── mock Gmail API ───────────────────────────────────────────────────────────
// Records every call so we can print what would have happened.
function buildMockGmail() {
  const calls = { sent: [], drafts: [], labels: [] };

  return {
    calls,
    async getUnread() {
      console.log(mock(`gmail.users.messages.list() → ${INBOX.length} unread messages`));
      return INBOX;
    },
    async sendReply(cfg, email, body) {
      calls.sent.push({ to: email.from.address, subject: email.subject, body });
      console.log(mock(`gmail.users.messages.send() → to: ${email.from.address}`));
    },
    async createDraft(cfg, email, body) {
      calls.drafts.push({ to: email.from.address, subject: email.subject, body });
      console.log(mock(`gmail.users.drafts.create() → draft saved for: ${email.from.address}`));
    },
    async addLabels(email, labels) {
      calls.labels.push({ id: email.id, labels });
      console.log(mock(`gmail.users.messages.modify() → labels: [${labels.join(', ')}] on msg ${email.id}`));
    },
  };
}

// ─── main ────────────────────────────────────────────────────────────────────
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Set ANTHROPIC_API_KEY in .env');
  process.exit(1);
}

const cfg  = loadConfig({ ...process.env, MODE: 'dry' });
const policy = parsePolicy(fs.readFileSync(cfg.policyPath, 'utf8'));
const client = new Anthropic();
const mockGmail = buildMockGmail();

// Pre-seed state: thread-005 already has a reply (simulates a thread we answered earlier).
// threadHasOurReply is set per email below using this set; in production the pipeline
// checks Gmail labels directly — state.has(email.id) only deduplicates messages, not threads.
const state = new State(null);
state.recordReply('omar@nile-traders.eg');
const REPLIED_THREADS = new Set(['thread-005']);

const deps = {
  cfg,
  policy,
  state,
  gmail: mockGmail,
  notify: async (msg) => console.log(mock(`slack.notify() → "${msg}"`)),
  classify: (email) => classifyEmail(client, cfg, email),
  draft: (email, cl) => draftReply(client, cfg, policy, email, cl),
};

const BAR = '─'.repeat(70);
const tally = {};

console.log('\n' + c(C.bold + C.cyan, 'Export Autopilot — Inbox Simulation'));
console.log(c(C.grey, '⚠  MOCK MODE: Gmail API calls are simulated (NDA restriction)'));
console.log(c(C.grey, '   AI classification and reply drafting use real Anthropic models'));
console.log(c(C.grey, '   Running in MODE=dry — nothing is sent\n'));

console.log(BAR);
console.log(c(C.bold, 'STEP 1 — Poll Gmail inbox'));
const messages = await mockGmail.getUnread();
console.log(`         Found ${messages.length} unread messages\n`);

console.log(BAR);
console.log(c(C.bold, 'STEP 2 — Process each message through pipeline\n'));

for (const [i, s] of messages.entries()) {
  const email = {
    ...s,
    from: parseAddress(s.from),
    messageId: `<${s.id}@sim>`,
    references: '',
    replyTo: null,
    hasAttachments: false,
    threadHasOurReply: REPLIED_THREADS.has(s.threadId),
  };

  console.log(c(C.bold, `[${i + 1}/${messages.length}] ${email.subject}`));
  console.log(`        from: ${s.from}`);

  const result = await processEmail(email, deps);
  tally[result.action] = (tally[result.action] || 0) + 1;

  const actionColors = {
    'dry-run':  C.green,   drafted: C.cyan,    replied: C.magenta,
    escalated:  C.red,     ignored: C.yellow,  skipped: C.grey,
  };
  const col = actionColors[result.action] || C.reset;
  console.log(`        → ${c(col + C.bold, result.action.toUpperCase())} in ${(result.ms / 1000).toFixed(1)}s`);
  console.log(`          ${result.reason}`);

  if (result.action === 'dry-run' && result.body) {
    console.log(c(C.grey, '\n        ── reply that would be sent ──'));
    console.log(indent(result.body, 8));
    console.log(c(C.grey, '        ── end ──'));
  }
  console.log();
}

console.log(BAR);
console.log(c(C.bold, 'STEP 3 — Summary\n'));
for (const [action, count] of Object.entries(tally)) {
  console.log(`  ${String(count).padStart(2)}  ${action}`);
}

console.log('\n' + c(C.bold, 'STEP 4 — What would happen next (in live MODE=send)'));
console.log(c(C.grey, '  Gmail labels applied: Autopilot-Replied / Autopilot-Needs-Human / Autopilot-Ignored'));
console.log(c(C.grey, '  State file updated: data/state.json'));
console.log(c(C.grey, '  Slack notifications sent for escalations and partial replies'));
console.log(c(C.grey, '  Loop waits 30 s then polls again\n'));

console.log(c(C.grey, '⚠  To run against a real inbox:'));
console.log(c(C.grey, '     1. npm run auth   (OAuth2 consent — NOT VERIFIED, NDA restriction)'));
console.log(c(C.grey, '     2. npm start      (live agent)'));
console.log(c(C.grey, '   gmail.test.js covers extractBody and buildRaw offline.\n'));
