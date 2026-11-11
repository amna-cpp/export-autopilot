import 'dotenv/config';
import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { assertGmailConfig, loadConfig } from './config.js';
import { classifyEmail } from './classify.js';
import { createGmail } from './gmail.js';
import { makeNotifier } from './notify.js';
import { processEmail } from './pipeline.js';
import { parsePolicy } from './policy.js';
import { draftReply } from './reply.js';
import { State } from './state.js';
import { log, sleep, withRetry } from './util.js';

const once = process.argv.includes('--once');

async function main() {
  const cfg = loadConfig();
  assertGmailConfig(cfg);
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Missing ANTHROPIC_API_KEY in .env');

  const policy = parsePolicy(fs.readFileSync(cfg.policyPath, 'utf8'));
  const client = new Anthropic();
  const gmail = createGmail(cfg);
  const state = new State(cfg.statePath).load();
  const notify = makeNotifier(cfg);
  const seen = new Set(); // MODE=dry never writes state, so remember in memory instead

  await gmail.ensureLabels(Object.values(cfg.labels));
  log(`Export Autopilot running. mode=${cfg.mode} policy=${cfg.policyPath} (${policy.sections.length} sections)`);
  if (cfg.mode === 'dry') log('DRY RUN: nothing will be sent, labelled or drafted.');

  const deps = {
    cfg,
    policy,
    state,
    gmail,
    notify,
    classify: (email) => classifyEmail(client, cfg, email),
    draft: (email, classification) => draftReply(client, cfg, policy, email, classification),
  };

  async function cycle() {
    const candidates = await withRetry(() => gmail.listCandidates(), {
      tries: cfg.retryTries,
      baseMs: cfg.retryBaseMs,
    });
    for (const { id, threadId } of candidates) {
      if (state.has(id) || seen.has(id)) continue;
      seen.add(id);
      try {
        const email = await withRetry(() => gmail.getEmail(id, threadId), {
          tries: cfg.retryTries,
          baseMs: cfg.retryBaseMs,
        });
        const result = await processEmail(email, deps);
        log(`${result.action.toUpperCase()} "${result.subject}" from ${result.from} in ${(result.ms / 1000).toFixed(1)}s: ${result.reason}`);
      } catch (err) {
        log(`Failed on message ${id}: ${err.message}`);
        seen.delete(id); // try again next cycle
      }
    }
  }

  let failures = 0;
  let alerted = false;
  do {
    try {
      await cycle();
      if (alerted) await notify('Export Autopilot recovered and is running normally again.');
      failures = 0;
      alerted = false;
    } catch (err) {
      failures += 1;
      log(`Cycle failed (${failures} in a row): ${err.message}`);
      if (/invalid_grant/i.test(err.message)) {
        await notify('Export Autopilot stopped: the Gmail token expired or was revoked. Re-run `npm run auth` and update GOOGLE_REFRESH_TOKEN.');
        process.exit(1);
      }
      if (failures >= 3 && !alerted) {
        alerted = true;
        await notify(`Export Autopilot is unhealthy: ${failures} failed cycles in a row. Last error: ${err.message}`);
      }
    }
    if (!once) await sleep(cfg.pollSeconds * 1000);
  } while (!once);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
