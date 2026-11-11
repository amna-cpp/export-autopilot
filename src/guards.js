/**
 * Deterministic safety checks. These run in plain code, so they still hold
 * even if the model is wrong, tricked, or having a bad day.
 */

/** Returns a reason string if the mail looks machine-generated, else null. */
export function automatedReason(email, selfAddress = '') {
  const h = email.headers || {};
  const from = email.from.address;

  if (selfAddress && from === selfAddress.toLowerCase()) return 'sent by ourselves';

  const auto = (h['auto-submitted'] || '').trim().toLowerCase();
  if (auto && auto !== 'no') return `Auto-Submitted: ${auto}`;

  if (/^(bulk|junk|list|auto_reply)$/i.test((h['precedence'] || '').trim())) {
    return `Precedence: ${h['precedence']}`;
  }
  if (h['list-id'] || h['list-unsubscribe']) return 'mailing list / newsletter';
  if (h['x-auto-response-suppress']) return 'auto-response suppressed';

  const local = from.split('@')[0];
  if (/^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster|bounces?)/i.test(local)) {
    return 'no-reply sender';
  }
  return null;
}

const SENSITIVE = [
  [/\b(lawyers?|attorneys?|solicitors?|lawsuit|suing|legal action|litigation|court order|subpoena)\b/i, 'legal threat or legal matter'],
  [/\b(fraud|fraudulent|scam|police|stolen)\b/i, 'fraud or police matter'],
  [/\b(sanctions?|sanctioned|embargo|ofac|export controls?|dual[- ]use|weapons?|military)\b/i, 'sanctions / export-control topic'],
  [/\b(iran|north korea|syria|cuba|crimea)\b/i, 'restricted destination mentioned'],
  [/\b(chargeback|refund|compensation)\b|\bdispute\s+(?:the\s+)?(?:payment|invoice|charge|advance|transfer|funds)\b|\b(?:payment|billing)\s+dispute\b/i, 'complaint or payment dispute'],
  [/\b(journalist|reporter|press (enquiry|inquiry)|media (enquiry|inquiry))\b/i, 'press enquiry'],
  [/\b(change (of )?(our|my|the) bank|new bank (details|account)|updated? (our|my) bank)\b/i, 'bank-detail change (possible payment fraud)'],
];

/** Returns a reason string if the text must go to a human, else null. */
export function sensitiveReason(text) {
  for (const [pattern, reason] of SENSITIVE) {
    if (pattern.test(text)) return reason;
  }
  return null;
}

const norm = (s) => String(s).toLowerCase().replace(/[\s,]/g, '');

const FIGURE = new RegExp(
  [
    '[$€£]\\s?\\d[\\d,]*(?:\\.\\d+)?',
    '(?:usd|eur|gbp)\\s?\\d[\\d,]*(?:\\.\\d+)?',
    '\\d[\\d,]*(?:\\.\\d+)?\\s?(?:%|percent|days?|weeks?|months?|units?|pcs|pieces|kg|tons?|tonnes?|usd|eur|gbp)',
  ].join('|'),
  'gi',
);

const CONTACT = /https?:\/\/[^\s<>)"']+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Any price, percentage, quantity, duration, link or email address in the
 * reply that does not literally appear in the policy. Catches invented numbers
 * and injected payment details even if the model "cited" a section.
 */
export function ungroundedFigures(reply, policyText) {
  const policyNorm = norm(policyText);
  const policyLower = String(policyText).toLowerCase();
  const out = [];

  for (const m of String(reply).match(FIGURE) || []) {
    const key = norm(m).replace(/s$/, '');
    if (!policyNorm.includes(key)) out.push(m.trim());
  }
  for (const m of String(reply).match(CONTACT) || []) {
    const cleaned = m.replace(/[.,;:]+$/, '').toLowerCase();
    if (!policyLower.includes(cleaned)) out.push(m);
  }
  return [...new Set(out)];
}

/** Returns a list of problems. Empty list = safe to send. */
export function validateDraft(draft, policy, cfg) {
  const problems = [];

  if (draft.needsHuman) problems.push(`model asked for a human${draft.reason ? `: ${draft.reason}` : ''}`);
  if (!draft.canAnswer) problems.push('policy does not cover this question');
  if (!draft.reply) problems.push('empty reply');
  if (draft.reply.length > 2500) problems.push('reply is unusually long');
  if (draft.confidence < cfg.minReplyConfidence) {
    problems.push(`low reply confidence (${draft.confidence.toFixed(2)})`);
  }

  if (!draft.sectionsUsed.length) {
    problems.push('no policy sections cited');
  } else {
    const unknown = draft.sectionsUsed.filter((id) => !policy.ids.has(id));
    if (unknown.length) problems.push(`cited sections that do not exist: ${unknown.join(', ')}`);
  }

  const ungrounded = ungroundedFigures(draft.reply, policy.text);
  if (ungrounded.length) problems.push(`not found in policy: ${ungrounded.join(', ')}`);

  return problems;
}
