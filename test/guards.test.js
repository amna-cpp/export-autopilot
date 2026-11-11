import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertGmailConfig, loadConfig } from '../src/config.js';
import { automatedReason, sensitiveReason, ungroundedFigures, validateDraft } from '../src/guards.js';
import { parsePolicy } from '../src/policy.js';
import { State } from '../src/state.js';
import { extractJson, parseAddress, withRetry } from '../src/util.js';
import { goodDraft, makeCfg, makeEmail, policy } from './helpers.js';

test('automatedReason flags machine mail and passes real customers', () => {
  const email = (headers, address = 'buyer@importer.test') => makeEmail({ headers, from: { name: '', address } });

  assert.ok(automatedReason(email({ 'auto-submitted': 'auto-replied' })));
  assert.ok(automatedReason(email({ precedence: 'bulk' })));
  assert.ok(automatedReason(email({ 'list-unsubscribe': '<mailto:x@y.z>' })));
  assert.ok(automatedReason(email({}, 'no-reply@shop.test')));
  assert.ok(automatedReason(email({}, 'mailer-daemon@googlemail.com')));
  assert.ok(automatedReason(email({}, 'sales@acme.test'), 'sales@acme.test'));
  assert.equal(automatedReason(email({ 'auto-submitted': 'no' })), null);
  assert.equal(automatedReason(email({})), null);
});

test('sensitiveReason catches the topics that must go to a human', () => {
  assert.ok(sensitiveReason('my lawyer will be in touch'));
  assert.ok(sensitiveReason('can you ship to Iran?'));
  assert.ok(sensitiveReason('we want a refund'));
  assert.ok(sensitiveReason('please note our new bank details'));
  assert.equal(sensitiveReason('What is your MOQ and lead time for Germany?'), null);
});

test('sensitiveReason does not escalate benign uses of "dispute"', () => {
  // Benign: "dispute resolution" is a normal business term
  assert.equal(sensitiveReason('What is your dispute resolution process?'), null);
  assert.equal(sensitiveReason('We have no dispute about your product quality.'), null);
  // Financial disputes still escalate
  assert.ok(sensitiveReason('We want to dispute the payment'));
  assert.ok(sensitiveReason('This is a billing dispute'));
  assert.ok(sensitiveReason('We will dispute the invoice'));
});

test('ungroundedFigures allows policy facts and catches invented ones', () => {
  const t = policy.text;
  assert.deepEqual(ungroundedFigures('Our MOQ is 500 units. Pay 30% advance.', t), []);
  assert.deepEqual(ungroundedFigures('Write to export@example.com.', t), []);
  assert.deepEqual(ungroundedFigures('You get 90% off.', t), ['90%']);
  assert.deepEqual(ungroundedFigures('MOQ is 200 units.', t), ['200 units']);
  assert.deepEqual(ungroundedFigures('Send $5,000 to https://pay.example/x', t), ['$5,000', 'https://pay.example/x']);
});

test('validateDraft passes a good draft and lists every problem in a bad one', () => {
  const cfg = makeCfg();
  assert.deepEqual(validateDraft(goodDraft, policy, cfg), []);

  const problems = validateDraft(
    { ...goodDraft, canAnswer: false, reply: '', sectionsUsed: [], confidence: 0.2, needsHuman: true },
    policy,
    cfg,
  );
  assert.ok(problems.length >= 5);
});

test('parsePolicy reads sections and rejects bad policies', () => {
  assert.equal(policy.sections.length, 3);
  assert.ok(policy.ids.has('EXP-2'));
  assert.throws(() => parsePolicy('just some text'), /no sections/);
  assert.throws(() => parsePolicy('## [EXP-1] A\nx\n## [EXP-1] B\ny'), /duplicate/);
});

test('State enforces a rolling 24h reply count and persists nothing when file is null', () => {
  const s = new State(null);
  const t0 = 1_000_000;
  s.recordReply('a@b.test', t0);
  s.recordReply('a@b.test', t0 + 1000);
  assert.equal(s.repliesInLastDay('a@b.test', t0 + 2000), 2);
  assert.equal(s.repliesInLastDay('a@b.test', t0 + 25 * 3600 * 1000), 0);
  assert.equal(s.repliesInLastDay('other@b.test', t0), 0);
});

test('extractJson tolerates code fences and chatter', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! {"a":2} hope that helps'), { a: 2 });
  assert.throws(() => extractJson('no json here'), /No JSON/);
});

test('parseAddress handles name and bare forms', () => {
  assert.deepEqual(parseAddress('Lena H <Lena@X.de>'), { name: 'Lena H', address: 'lena@x.de' });
  assert.deepEqual(parseAddress('"Doe, J" <j@x.de>'), { name: 'Doe, J', address: 'j@x.de' });
  assert.deepEqual(parseAddress('bare@x.de'), { name: '', address: 'bare@x.de' });
});

test('withRetry backs off, and fails fast on permanent errors', async () => {
  const waits = [];
  let n = 0;
  const value = await withRetry(
    async () => {
      n += 1;
      if (n < 3) throw new Error('temporary');
      return 'ok';
    },
    { tries: 3, baseMs: 100, sleepFn: async (ms) => waits.push(ms) },
  );
  assert.equal(value, 'ok');
  assert.deepEqual(waits, [100, 200]);

  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw Object.assign(new Error('bad token'), { status: 401 });
      },
      { tries: 3, sleepFn: async () => {} },
    ),
    /bad token/,
  );
  assert.equal(calls, 1);
});

test('config rejects an unknown MODE and reports missing Gmail settings', () => {
  assert.throws(() => loadConfig({ MODE: 'yolo' }), /MODE must be/);
  assert.throws(() => assertGmailConfig(loadConfig({})), /GOOGLE_CLIENT_ID/);
});
