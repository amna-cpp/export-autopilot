import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRaw, extractBody } from '../src/gmail.js';
import { makeCfg, makeEmail } from './helpers.js';

const cfg = makeCfg();

// ---------------------------------------------------------------------------
// extractBody
// ---------------------------------------------------------------------------

test('extractBody returns plain text when present', () => {
  const encoded = Buffer.from('Hello world', 'utf8').toString('base64');
  const payload = { mimeType: 'text/plain', body: { data: encoded } };
  assert.equal(extractBody(payload), 'Hello world');
});

test('extractBody falls back to stripped HTML when no plain text', () => {
  const encoded = Buffer.from('<p>Hello <b>world</b></p>', 'utf8').toString('base64');
  const payload = { mimeType: 'text/html', body: { data: encoded } };
  assert.match(extractBody(payload), /Hello world/);
});

test('extractBody prefers plain text over HTML in multipart/alternative', () => {
  const plain = Buffer.from('plain text', 'utf8').toString('base64');
  const html = Buffer.from('<p>html text</p>', 'utf8').toString('base64');
  const payload = {
    mimeType: 'multipart/alternative',
    parts: [
      { mimeType: 'text/plain', body: { data: plain } },
      { mimeType: 'text/html', body: { data: html } },
    ],
  };
  assert.equal(extractBody(payload), 'plain text');
});

test('extractBody walks nested multipart/mixed', () => {
  const plain = Buffer.from('nested plain', 'utf8').toString('base64');
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [{ mimeType: 'text/plain', body: { data: plain } }],
      },
      { mimeType: 'application/pdf', body: { attachmentId: 'att1', size: 5000 } },
    ],
  };
  assert.equal(extractBody(payload), 'nested plain');
});

// ---------------------------------------------------------------------------
// buildRaw
// ---------------------------------------------------------------------------

test('buildRaw produces a base64url string', () => {
  const email = makeEmail({ messageId: '<abc@test>', references: '' });
  const raw = buildRaw(cfg, email, 'Hello');
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  assert.match(decoded, /^From:/m);
  assert.match(decoded, /^To:/m);
  assert.match(decoded, /^Subject: Re: /m);
  assert.match(decoded, /In-Reply-To: <abc@test>/m);
});

test('buildRaw does not double "Re:" on already-prefixed subjects', () => {
  const email = makeEmail({ subject: 'Re: MOQ question' });
  const raw = buildRaw(cfg, email, 'Answer');
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  assert.doesNotMatch(decoded, /Re: Re:/);
  assert.match(decoded, /^Subject: Re: MOQ question/m);
});

test('buildRaw encodes non-ASCII subjects with RFC 2047', () => {
  const email = makeEmail({ subject: 'Anfrage über Produkte' });
  const raw = buildRaw(cfg, email, 'Answer');
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  assert.match(decoded, /=\?UTF-8\?B\?/);
});

test('buildRaw uses Reply-To address instead of From when replyTo is set', () => {
  const email = makeEmail({ replyTo: 'replyto@other.test' });
  const raw = buildRaw(cfg, email, 'Answer');
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  assert.match(decoded, /^To: replyto@other\.test/m);
  assert.doesNotMatch(decoded, /buyer@importer\.test/);
});

test('buildRaw falls back to From address when replyTo is null', () => {
  const email = makeEmail({ replyTo: null });
  const raw = buildRaw(cfg, email, 'Answer');
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  assert.match(decoded, /^To: buyer@importer\.test/m);
});

test('buildRaw sets correct threadId in the raw message header', () => {
  const email = makeEmail({ messageId: '<orig@test>', references: '<prev@test>' });
  const raw = buildRaw(cfg, email, 'Body text');
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  assert.match(decoded, /References: <prev@test> <orig@test>/m);
});
