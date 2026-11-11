export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const log = (...args) => console.log(new Date().toISOString(), ...args);

export function clamp01(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

/** "Name <a@b.com>" -> { name, address } (address is lower-cased). */
export function parseAddress(raw = '') {
  const m = String(raw).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), address: m[2].trim().toLowerCase() };
  return { name: '', address: String(raw).trim().toLowerCase() };
}

/** Pull the first JSON object out of model output (tolerates code fences and chatter). */
export function extractJson(text) {
  const cleaned = String(text).replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('No JSON object in model output');
  return JSON.parse(cleaned.slice(start, end + 1));
}

/**
 * Wrap an email for the model. The body is untrusted: strip any of our own
 * delimiter tags so a sender cannot "close" the email block and add instructions.
 */
export function renderEmail(email, maxChars = 6000) {
  const strip = (s = '') => String(s).replace(/<\/?(email|from|subject|body|policy|attachments)>/gi, '');
  const from = email.from.name
    ? `${strip(email.from.name)} <${strip(email.from.address)}>`
    : strip(email.from.address);
  const parts = [
    '<email>',
    `<from>${from}</from>`,
    `<subject>${strip(email.subject)}</subject>`,
    '<body>',
    strip(email.body).slice(0, maxChars),
    '</body>',
  ];
  if (email.hasAttachments) {
    parts.push('<attachments>This email has file attachments. You cannot read them. Do not assume or guess their contents.</attachments>');
  }
  parts.push('</email>');
  return parts.join('\n');
}

function defaultShouldRetry(err) {
  const status = err?.status ?? err?.code ?? err?.response?.status;
  if (status === 400 || status === 401 || status === 404) return false;
  if (status === 403) return /rate|quota/i.test(String(err?.message));
  if (/invalid_grant/i.test(String(err?.message))) return false;
  return true;
}

/** Retry with exponential backoff. Permanent errors (bad request, auth) fail fast. */
export async function withRetry(fn, opts = {}) {
  const {
    tries = 3,
    baseMs = 500,
    sleepFn = sleep,
    onRetry,
    shouldRetry = defaultShouldRetry,
  } = opts;
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === tries || !shouldRetry(err)) break;
      const wait = baseMs * 2 ** (attempt - 1);
      onRetry?.(err, attempt, wait);
      await sleepFn(wait);
    }
  }
  throw lastErr;
}
