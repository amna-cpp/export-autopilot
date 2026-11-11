# Export Autopilot

A small agent that lives in a company Gmail inbox. When a new email is an
export enquiry, it replies within seconds, using only the company's written
export policy. Anything it is not sure about goes to a human.

## What happens to each email

1. **Machine mail is skipped** (auto-replies, newsletters, no-reply senders). This stops bot-to-bot loops.
2. **Already answered?** If we replied in this thread before, a human takes over.
3. **Classify** with a fast model: is this an export query? Low confidence goes to a human.
4. **Hard rules in code**: legal threats, fraud, sanctions or restricted countries, refunds and disputes, bank-detail changes and press go to a human.
5. **Write the reply** with a stronger model, from the policy only, citing the policy sections it used.
6. **Check the reply in code before sending.** It is blocked if it cites a section that does not exist, contains any price, percentage, quantity, duration, link or email address that is not in the policy, or the model flagged it.
7. **Send** (or save as draft, or just print, depending on `MODE`). Partial answers are sent for the covered part, and the rest is flagged for a human.

When a human is needed: the email gets the `Autopilot-Needs-Human` label in Gmail
and a Slack message (if configured) with the reason and the blocked draft.

## Self-healing

- Model and Gmail calls retry with backoff. Permanent errors (bad token) fail fast.
- One bad email never stops the loop. It is escalated and the bot moves on.
- 3 failed cycles in a row sends a Slack alert. An expired Gmail token sends an alert and stops cleanly.
- The bot says when it recovers.
- Sends are never retried, so a customer cannot get a duplicate.

## Setup (about 15 minutes)

```bash
npm install
cp .env.example .env
```

1. **Policy**: edit `policies/export-policy.md`. Keep the `## [EXP-1] Title` format. The bot can only say what is written here.
2. **Google credentials**: in Google Cloud Console, create a project, enable the Gmail API, create an OAuth client of type "Desktop app", and add the Gmail account as a test user. Put the client ID and secret in `.env`.
3. **Get a Gmail token**: `npm run auth`, open the link, sign in with the company account, paste the printed `GOOGLE_REFRESH_TOKEN` line into `.env`.
4. **Add** `ANTHROPIC_API_KEY`, `COMPANY_NAME` and `GMAIL_ADDRESS` to `.env`.

## Roll out safely

| Step | Command | What it does |
| --- | --- | --- |
| 1. Test the brain | `npm run demo` | Runs 9 sample emails (including a legal threat and a prompt-injection attempt) through the real models. No Gmail, nothing sent. |
| 2. Watch real mail | `MODE=dry npm run once` | Reads the real inbox and prints what it would do. Touches nothing. |
| 3. Human in the loop | `MODE=draft npm start` | Saves replies as Gmail drafts. A person presses send. |
| 4. Autopilot | `MODE=send npm start` | Replies automatically. |

Keep it running with pm2, systemd, or any small server or container.

```bash
npm test   # 32 offline tests, no API key or Gmail needed
```

## Limits (read these)

- It polls every `POLL_SECONDS` (default 20). That is "within seconds" in practice. Gmail push notifications via Pub/Sub would make it instant.
- It replies to the `From` address, not `Reply-To`. Website contact-form mail from a no-reply address is skipped on purpose.
- The figure check is strict. If the model rewrites "35 days" as "5 weeks", the reply is blocked and escalated. That is the safe direction.
- The reply is plain text and ends with a line saying it is an automated first response. Change the wording with `DISCLOSURE`.
- The Gmail layer (`src/gmail.js`) uses the official `googleapis` client. Run steps 2 and 3 above on your real inbox before trusting it.
