import { log } from './util.js';

/** Best-effort Slack ping. Never throws: a broken webhook must not stop the bot. */
export function makeNotifier(cfg) {
  return async function notify(text) {
    log('NOTIFY', text.replace(/\n/g, ' | '));
    if (!cfg.slackWebhookUrl) return;
    try {
      const res = await fetch(cfg.slackWebhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) log(`Slack webhook returned ${res.status}`);
    } catch (err) {
      log(`Slack webhook failed: ${err.message}`);
    }
  };
}
