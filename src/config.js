const num = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export function loadConfig(env = process.env) {
  const companyName = env.COMPANY_NAME || 'Our Company';
  const prefix = env.LABEL_PREFIX || 'Autopilot';
  const mode = (env.MODE || 'dry').toLowerCase();
  if (!['dry', 'draft', 'send'].includes(mode)) {
    throw new Error(`MODE must be dry, draft or send (got "${mode}")`);
  }

  return {
    companyName,
    mode,
    pollSeconds: num(env.POLL_SECONDS, 20),
    policyPath: env.POLICY_PATH || 'policies/export-policy.md',
    statePath: env.STATE_PATH || 'data/state.json',
    classifyModel: env.CLASSIFY_MODEL || 'claude-haiku-5-5',
    replyModel: env.REPLY_MODEL || 'claude-sonnet-5-5',
    minClassifyConfidence: num(env.MIN_CLASSIFY_CONFIDENCE, 0.8),
    minReplyConfidence: num(env.MIN_REPLY_CONFIDENCE, 0.8),
    maxRepliesPerSenderPerDay: num(env.MAX_REPLIES_PER_SENDER_PER_DAY, 3),
    retryTries: num(env.RETRY_TRIES, 3),
    retryBaseMs: num(env.RETRY_BASE_MS, 500),
    slackWebhookUrl: env.SLACK_WEBHOOK_URL || '',
    disclosure:
      env.DISCLOSURE ||
      'This is an automated first response. If anything is unclear, just reply and a team member will pick it up.',
    labels: {
      replied: `${prefix}-Replied`,
      drafted: `${prefix}-Drafted`,
      needsHuman: `${prefix}-Needs-Human`,
      ignored: `${prefix}-Ignored`,
    },
    gmail: {
      userEmail: (env.GMAIL_ADDRESS || '').toLowerCase(),
      clientId: env.GOOGLE_CLIENT_ID || '',
      clientSecret: env.GOOGLE_CLIENT_SECRET || '',
      refreshToken: env.GOOGLE_REFRESH_TOKEN || '',
    },
  };
}

export function assertGmailConfig(cfg) {
  const missing = [];
  if (!cfg.gmail.userEmail) missing.push('GMAIL_ADDRESS');
  if (!cfg.gmail.clientId) missing.push('GOOGLE_CLIENT_ID');
  if (!cfg.gmail.clientSecret) missing.push('GOOGLE_CLIENT_SECRET');
  if (!cfg.gmail.refreshToken) missing.push('GOOGLE_REFRESH_TOKEN (run `npm run auth`)');
  if (missing.length) throw new Error(`Missing in .env: ${missing.join(', ')}`);
}
