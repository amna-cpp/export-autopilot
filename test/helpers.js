import { loadConfig } from '../src/config.js';
import { parsePolicy } from '../src/policy.js';
import { State } from '../src/state.js';

export const POLICY_MD = `# Test policy

## [EXP-1] MOQ
Standard MOQ is 500 units. First orders can be 300 units.

## [EXP-2] Payment
New customers pay 30% advance and 70% before shipment. Contact export@example.com.

## [ESC-1] Escalate
Legal threats go to a human.
`;

export const policy = parsePolicy(POLICY_MD);

export const makeCfg = (overrides = {}) => ({
  ...loadConfig({ COMPANY_NAME: 'Acme', MODE: 'send', GMAIL_ADDRESS: 'sales@acme.test' }),
  retryTries: 2,
  retryBaseMs: 0,
  ...overrides,
});

export const makeEmail = (overrides = {}) => ({
  id: 'm1',
  threadId: 't1',
  from: { name: 'Buyer', address: 'buyer@importer.test' },
  subject: 'MOQ question',
  body: 'Hello, what is your MOQ?',
  headers: {},
  messageId: '<m1@importer.test>',
  references: '',
  replyTo: null,
  hasAttachments: false,
  threadHasOurReply: false,
  ...overrides,
});

export const goodClassification = {
  isExport: true,
  topic: 'moq',
  confidence: 0.95,
  language: 'en',
  reason: 'asks about MOQ',
};

export const goodDraft = {
  canAnswer: true,
  reply: 'Hello,\n\nOur standard MOQ is 500 units.\n\nBest regards,\nAcme Export Team',
  sectionsUsed: ['EXP-1'],
  unanswered: [],
  confidence: 0.93,
  needsHuman: false,
  reason: '',
};

export function fakeGmail({ failSend = false } = {}) {
  const calls = { sent: [], drafts: [], labels: [] };
  return {
    calls,
    async sendReply(email, body) {
      if (failSend) throw new Error('smtp down');
      calls.sent.push({ email, body });
    },
    async createDraft(email, body) {
      calls.drafts.push({ email, body });
    },
    async addLabels(id, labels) {
      calls.labels.push({ id, labels });
    },
  };
}

/** Build pipeline deps with spies. Override any piece per test. */
export function makeDeps(overrides = {}) {
  const counts = { classify: 0, draft: 0 };
  const notes = [];
  const deps = {
    cfg: makeCfg(),
    policy,
    state: new State(null),
    gmail: fakeGmail(),
    notify: async (text) => notes.push(text),
    sleepFn: async () => {},
    classify: async () => {
      counts.classify += 1;
      return goodClassification;
    },
    draft: async () => {
      counts.draft += 1;
      return goodDraft;
    },
    ...overrides,
  };
  return { deps, counts, notes };
}
