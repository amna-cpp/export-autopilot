import { google } from 'googleapis';
import { parseAddress } from './util.js';

const headerMap = (headers = []) =>
  Object.fromEntries(headers.map((h) => [h.name.toLowerCase(), h.value]));

const decode = (data = '') => Buffer.from(data, 'base64url').toString('utf8');

const stripHtml = (html) =>
  html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** Prefer text/plain; fall back to stripped text/html. Walks nested multiparts. */
export function extractBody(payload) {
  const plain = [];
  const html = [];
  (function walk(part) {
    if (!part) return;
    if (part.mimeType === 'text/plain' && part.body?.data) plain.push(decode(part.body.data));
    else if (part.mimeType === 'text/html' && part.body?.data) html.push(decode(part.body.data));
    (part.parts || []).forEach(walk);
  })(payload);
  if (plain.length) return plain.join('\n').trim();
  return stripHtml(html.join('\n'));
}

/** True if the message has any file attachment (any part with an attachmentId). */
function detectAttachments(payload) {
  let found = false;
  (function walk(part) {
    if (!part || found) return;
    if (part.body?.attachmentId) { found = true; return; }
    (part.parts || []).forEach(walk);
  })(payload);
  return found;
}

const encodeHeader = (value) =>
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;

/** Build a threaded reply as a base64url RFC 2822 message. */
export function buildRaw(cfg, email, body) {
  const subject = /^re:/i.test(email.subject) ? email.subject : `Re: ${email.subject}`;
  const refs = [email.references, email.messageId].filter(Boolean).join(' ');
  const to = email.replyTo || email.from.address;
  const lines = [
    `From: ${cfg.gmail.userEmail}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    email.messageId ? `In-Reply-To: ${email.messageId}` : null,
    refs ? `References: ${refs}` : null,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body, 'utf8').toString('base64').replace(/(.{76})/g, '$1\n'),
  ].filter((l) => l !== null);
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}

export function createGmail(cfg) {
  const auth = new google.auth.OAuth2(cfg.gmail.clientId, cfg.gmail.clientSecret);
  auth.setCredentials({ refresh_token: cfg.gmail.refreshToken });
  const gmail = google.gmail({ version: 'v1', auth });
  const labelIds = new Map();

  return {
    async ensureLabels(names) {
      const { data } = await gmail.users.labels.list({ userId: 'me' });
      const existing = new Map((data.labels || []).map((l) => [l.name, l.id]));
      for (const name of names) {
        if (existing.has(name)) {
          labelIds.set(name, existing.get(name));
          continue;
        }
        const created = await gmail.users.labels.create({
          userId: 'me',
          requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
        });
        labelIds.set(name, created.data.id);
      }
    },

    /** Unread inbox mail from the last 2 days that we have not labelled yet. */
    async listCandidates(max = 20) {
      const skip = Object.values(cfg.labels).map((l) => `-label:${l}`).join(' ');
      const { data } = await gmail.users.messages.list({
        userId: 'me',
        q: `in:inbox is:unread -from:me newer_than:2d ${skip}`,
        maxResults: max,
      });
      return (data.messages || []).map((m) => ({ id: m.id, threadId: m.threadId }));
    },

    async getEmail(id, threadId) {
      const { data: thread } = await gmail.users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'full',
      });
      const messages = thread.messages || [];
      const msg = messages.find((m) => m.id === id);
      if (!msg) throw new Error(`message ${id} not found in thread ${threadId}`);

      const headers = headerMap(msg.payload?.headers);
      const self = cfg.gmail.userEmail;
      const threadHasOurReply = messages.some((m) => {
        if (m.id === id) return false;
        const from = parseAddress(headerMap(m.payload?.headers)['from'] || '').address;
        return from === self || (m.labelIds || []).includes('SENT');
      });

      return {
        id,
        threadId,
        from: parseAddress(headers['from'] || ''),
        subject: headers['subject'] || '(no subject)',
        body: extractBody(msg.payload),
        headers,
        messageId: headers['message-id'] || '',
        references: headers['references'] || '',
        replyTo: headers['reply-to'] ? parseAddress(headers['reply-to']).address : null,
        hasAttachments: detectAttachments(msg.payload),
        threadHasOurReply,
      };
    },

    async sendReply(email, body) {
      await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: buildRaw(cfg, email, body), threadId: email.threadId },
      });
    },

    async createDraft(email, body) {
      await gmail.users.drafts.create({
        userId: 'me',
        requestBody: { message: { raw: buildRaw(cfg, email, body), threadId: email.threadId } },
      });
    },

    async addLabels(id, names) {
      const ids = names.map((n) => labelIds.get(n)).filter(Boolean);
      if (!ids.length) throw new Error(`unknown labels: ${names.join(', ')}`);
      await gmail.users.messages.modify({ userId: 'me', id, requestBody: { addLabelIds: ids } });
    },
  };
}
