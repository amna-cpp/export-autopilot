import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processEmail } from '../src/pipeline.js';
import {
  fakeGmail,
  goodClassification,
  goodDraft,
  makeCfg,
  makeDeps,
  makeEmail,
} from './helpers.js';

test('replies to a grounded export query and labels the mail', async () => {
  const { deps, counts } = makeDeps();
  const result = await processEmail(makeEmail(), deps);

  assert.equal(result.action, 'replied');
  assert.equal(counts.classify, 1);
  assert.equal(deps.gmail.calls.sent.length, 1);
  assert.match(deps.gmail.calls.sent[0].body, /500 units/);
  assert.match(deps.gmail.calls.sent[0].body, /automated first response/);
  assert.deepEqual(deps.gmail.calls.labels[0].labels, ['Autopilot-Replied']);
  assert.ok(deps.state.has('m1'));
  assert.equal(deps.state.repliesInLastDay('buyer@importer.test'), 1);
});

test('dry mode touches nothing', async () => {
  const { deps } = makeDeps({ cfg: makeCfg({ mode: 'dry' }) });
  const result = await processEmail(makeEmail(), deps);

  assert.equal(result.action, 'dry-run');
  assert.ok(result.body.includes('500 units'));
  assert.equal(deps.gmail.calls.sent.length, 0);
  assert.equal(deps.gmail.calls.labels.length, 0);
  assert.equal(deps.state.has('m1'), false);
});

test('draft mode saves a draft and does not send', async () => {
  const { deps } = makeDeps({ cfg: makeCfg({ mode: 'draft' }) });
  const result = await processEmail(makeEmail(), deps);

  assert.equal(result.action, 'drafted');
  assert.equal(deps.gmail.calls.drafts.length, 1);
  assert.equal(deps.gmail.calls.sent.length, 0);
});

test('ignores non-export mail without drafting a reply', async () => {
  const { deps, counts } = makeDeps({
    classify: async () => ({ ...goodClassification, isExport: false, topic: 'not_export' }),
  });
  const result = await processEmail(makeEmail({ subject: 'Job application' }), deps);

  assert.equal(result.action, 'ignored');
  assert.equal(counts.draft, 0);
  assert.equal(deps.gmail.calls.sent.length, 0);
  assert.deepEqual(deps.gmail.calls.labels[0].labels, ['Autopilot-Ignored']);
});

test('skips automated mail before calling any model', async () => {
  const { deps, counts } = makeDeps();
  const result = await processEmail(makeEmail({ headers: { 'auto-submitted': 'auto-replied' } }), deps);

  assert.equal(result.action, 'skipped');
  assert.equal(counts.classify, 0);
  assert.equal(deps.gmail.calls.sent.length, 0);
});

test('escalates when classification confidence is low', async () => {
  const { deps, notes } = makeDeps({
    classify: async () => ({ ...goodClassification, confidence: 0.4 }),
  });
  const result = await processEmail(makeEmail(), deps);

  assert.equal(result.action, 'escalated');
  assert.equal(deps.gmail.calls.sent.length, 0);
  assert.deepEqual(deps.gmail.calls.labels[0].labels, ['Autopilot-Needs-Human']);
  assert.equal(notes.length, 1);
});

test('escalates legal threats even when email is not an export query', async () => {
  const { deps, counts } = makeDeps({
    classify: async () => ({ ...goodClassification, isExport: false, topic: 'not_export' }),
  });
  const result = await processEmail(
    makeEmail({ subject: 'Delayed shipment', body: 'My lawyer will contact you. We will dispute the advance payment.' }),
    deps,
  );

  assert.equal(result.action, 'escalated');
  assert.equal(counts.classify, 0); // caught before classification
  assert.equal(deps.gmail.calls.sent.length, 0);
});

test('escalates legal threats in code, before any model call', async () => {
  const { deps, counts } = makeDeps();
  const result = await processEmail(
    makeEmail({ body: 'My lawyer will contact you about our MOQ order.' }),
    deps,
  );

  assert.equal(result.action, 'escalated');
  assert.match(result.reason, /legal/);
  assert.equal(counts.classify, 0); // caught before classification
  assert.equal(counts.draft, 0);
  assert.equal(deps.gmail.calls.sent.length, 0);
});

test('blocks a draft that cites a policy section that does not exist', async () => {
  const { deps } = makeDeps({ draft: async () => ({ ...goodDraft, sectionsUsed: ['EXP-99'] }) });
  const result = await processEmail(makeEmail(), deps);

  assert.equal(result.action, 'escalated');
  assert.match(result.reason, /EXP-99/);
  assert.equal(deps.gmail.calls.sent.length, 0);
});

test('blocks a draft that contains a discount not in the policy', async () => {
  const { deps, notes } = makeDeps({
    draft: async () => ({ ...goodDraft, reply: 'Sure, we can give you a 90% discount.' }),
  });
  const result = await processEmail(makeEmail(), deps);

  assert.equal(result.action, 'escalated');
  assert.match(result.reason, /90%/);
  assert.equal(deps.gmail.calls.sent.length, 0);
  assert.match(notes[0], /NOT sent/);
});

test('blocks a draft that contains an unknown email address or link', async () => {
  const { deps } = makeDeps({
    draft: async () => ({ ...goodDraft, reply: 'Our MOQ is 500 units. Pay at https://evil.example/pay' }),
  });
  const result = await processEmail(makeEmail(), deps);

  assert.equal(result.action, 'escalated');
  assert.match(result.reason, /evil\.example/);
});

test('retries a flaky model call, then escalates if it keeps failing', async () => {
  let attempts = 0;
  const { deps } = makeDeps({
    draft: async () => {
      attempts += 1;
      throw new Error('overloaded');
    },
  });
  const result = await processEmail(makeEmail(), deps);

  assert.equal(attempts, 2); // retryTries = 2 in test config
  assert.equal(result.action, 'escalated');
  assert.match(result.reason, /drafting failed/);
  assert.equal(deps.gmail.calls.sent.length, 0);
});

test('recovers when the model fails once and then works', async () => {
  let attempts = 0;
  const { deps } = makeDeps({
    draft: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('timeout');
      return goodDraft;
    },
  });
  const result = await processEmail(makeEmail(), deps);

  assert.equal(result.action, 'replied');
  assert.equal(attempts, 2);
});

test('hands follow-ups in a thread we already answered to a human', async () => {
  const { deps, counts } = makeDeps();
  const result = await processEmail(makeEmail({ threadHasOurReply: true }), deps);

  assert.equal(result.action, 'escalated');
  assert.equal(counts.classify, 0);
  assert.equal(deps.gmail.calls.sent.length, 0);
});

test('stops replying to a sender who hits the daily limit (loop guard)', async () => {
  const { deps } = makeDeps();
  for (let i = 0; i < 3; i++) deps.state.recordReply('buyer@importer.test');
  const result = await processEmail(makeEmail(), deps);

  assert.equal(result.action, 'escalated');
  assert.match(result.reason, /limit/);
  assert.equal(deps.gmail.calls.sent.length, 0);
});

test('sends the covered answer and flags the rest for a human', async () => {
  const { deps, notes } = makeDeps({
    draft: async () => ({ ...goodDraft, unanswered: ['Do you hold OEKO-TEX certification?'] }),
  });
  const result = await processEmail(makeEmail(), deps);

  assert.equal(result.action, 'replied');
  assert.equal(deps.gmail.calls.sent.length, 1);
  assert.deepEqual(deps.gmail.calls.labels[0].labels, ['Autopilot-Replied', 'Autopilot-Needs-Human']);
  assert.match(notes[0], /OEKO-TEX/);
});

test('escalates instead of replying when the send fails', async () => {
  const { deps } = makeDeps({ gmail: fakeGmail({ failSend: true }) });
  const result = await processEmail(makeEmail(), deps);

  assert.equal(result.action, 'escalated');
  assert.match(result.reason, /send failed/);
  assert.equal(deps.state.repliesInLastDay('buyer@importer.test'), 0);
});
