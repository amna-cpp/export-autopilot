import { automatedReason, sensitiveReason, validateDraft } from './guards.js';
import { composeBody } from './reply.js';
import { log, withRetry } from './util.js';

/**
 * Handle one email, start to finish. Every exit is one of:
 *   skipped   machine-generated mail, ignored silently
 *   ignored   classified as not an export query (labelled, left alone)
 *   escalated a human is needed (labelled + notified, nothing sent)
 *   dry-run   would have replied (MODE=dry, nothing touched)
 *   drafted   reply saved as a Gmail draft (MODE=draft)
 *   replied   reply sent (MODE=send)
 *
 * deps = { cfg, policy, state, gmail, classify, draft, notify?, sleepFn? }
 * Everything external is injected, so the whole flow is testable offline.
 */
export async function processEmail(email, deps) {
  const { cfg, policy, state, gmail, classify, draft } = deps;
  const notify = deps.notify || (async () => {});
  const started = Date.now();
  const live = cfg.mode !== 'dry';

  const retry = (fn, label, tries) =>
    withRetry(fn, {
      tries: tries ?? cfg.retryTries,
      baseMs: cfg.retryBaseMs,
      sleepFn: deps.sleepFn,
      onRetry: (err, attempt, wait) => log(`retry ${label} #${attempt} in ${wait}ms: ${err.message}`),
    });

  const finish = (action, reason, extra = {}) => ({
    id: email.id,
    subject: email.subject,
    from: email.from.address,
    action,
    reason,
    ms: Date.now() - started,
    ...extra,
  });

  const safely = async (fn, what) => {
    try {
      await fn();
    } catch (err) {
      log(`${what} failed (continuing): ${err.message}`);
    }
  };

  async function escalate(reason, extra = {}) {
    if (live) {
      await safely(() => gmail.addLabels(email.id, [cfg.labels.needsHuman]), 'labelling');
      state.mark(email.id);
    }
    let note = `Needs a human: "${email.subject}" from ${email.from.address}\nReason: ${reason}`;
    if (extra.draft?.reply) note += `\n\nSuggested draft (NOT sent):\n${extra.draft.reply}`;
    await notify(note);
    return finish('escalated', reason, extra);
  }

  // 1. Machine mail: never reply (this is what prevents bot-to-bot loops).
  const auto = automatedReason(email, cfg.gmail.userEmail);
  if (auto) {
    if (live) state.mark(email.id);
    return finish('skipped', auto);
  }

  // 2. We (or a colleague) already answered this thread: a human takes over.
  if (email.threadHasOurReply) {
    return escalate('follow-up in a thread we already replied to');
  }

  // 3. Hard safety rules — run before any model call so legal threats, fraud,
  //    and sanctions mentions always reach a human, even in non-export emails.
  const sensitive = sensitiveReason(`${email.subject}\n${email.body}`);
  if (sensitive) return escalate(sensitive);

  // 4. Classify (fast, cheap model).
  let classification;
  try {
    classification = await retry(() => classify(email), 'classify');
  } catch (err) {
    return escalate(`classifier failed: ${err.message}`);
  }

  if (classification.confidence < cfg.minClassifyConfidence) {
    return escalate(
      `unsure how to classify (${classification.confidence.toFixed(2)}): ${classification.reason}`,
      { classification },
    );
  }

  if (!classification.isExport) {
    if (live) {
      await safely(() => gmail.addLabels(email.id, [cfg.labels.ignored]), 'labelling');
      state.mark(email.id);
    }
    return finish('ignored', `not an export query: ${classification.reason}`, { classification });
  }

  // 5. Reply limit check (after classification so only export queries count).

  if (state.repliesInLastDay(email.from.address) >= cfg.maxRepliesPerSenderPerDay) {
    return escalate('reply limit reached for this sender (loop guard)', { classification });
  }

  // 6. Draft the reply from the policy.
  let d;
  try {
    d = await retry(() => draft(email, classification), 'draft');
  } catch (err) {
    return escalate(`reply drafting failed: ${err.message}`, { classification });
  }

  // 7. Verify the draft in code before it can leave the building.
  const problems = validateDraft(d, policy, cfg);
  if (problems.length) {
    return escalate(problems.join('; '), { classification, draft: d });
  }

  const body = composeBody(cfg, d);
  const extra = { classification, draft: d, body };

  if (cfg.mode === 'dry') return finish('dry-run', 'would reply', extra);

  if (cfg.mode === 'draft') {
    try {
      await retry(() => gmail.createDraft(email, body), 'create draft');
    } catch (err) {
      return escalate(`could not create draft: ${err.message}`, extra);
    }
    await safely(() => gmail.addLabels(email.id, [cfg.labels.drafted]), 'labelling');
    state.mark(email.id);
    return finish('drafted', 'draft saved for review', extra);
  }

  // MODE=send. No retry on the send itself: a lost response after Gmail
  // accepted the mail would otherwise send the customer a duplicate.
  try {
    await gmail.sendReply(email, body);
  } catch (err) {
    return escalate(`send failed: ${err.message}`, extra);
  }
  state.recordReply(email.from.address);

  const labels = [cfg.labels.replied];
  if (d.unanswered.length) labels.push(cfg.labels.needsHuman);
  await safely(() => gmail.addLabels(email.id, labels), 'labelling');
  state.mark(email.id);

  if (d.unanswered.length) {
    await notify(
      `Partial reply sent to ${email.from.address} ("${email.subject}"). Please follow up on:\n- ${d.unanswered.join('\n- ')}`,
    );
  }
  return finish('replied', `answered from ${d.sectionsUsed.join(', ')}`, extra);
}
