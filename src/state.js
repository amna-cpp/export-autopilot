import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_PROCESSED_MS = 7 * DAY_MS;

/**
 * Tiny JSON-file store: which messages we already handled, and how many
 * auto-replies each sender got in the last 24h (loop guard).
 * Pass file = null for in-memory only (tests, demo).
 */
export class State {
  constructor(file = null) {
    this.file = file;
    this.data = { processed: {}, replies: {} };
  }

  load() {
    if (this.file && fs.existsSync(this.file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = { processed: {}, replies: {}, ...parsed };
      } catch {
        // Corrupt file: start fresh. Gmail labels still stop most re-processing.
      }
    }
    return this;
  }

  has(id) {
    return id in this.data.processed;
  }

  mark(id, now = Date.now()) {
    this.data.processed[id] = now;
    this.save(now);
  }

  repliesInLastDay(sender, now = Date.now()) {
    return (this.data.replies[sender] || []).filter((t) => now - t < DAY_MS).length;
  }

  recordReply(sender, now = Date.now()) {
    const list = (this.data.replies[sender] || []).filter((t) => now - t < DAY_MS);
    list.push(now);
    this.data.replies[sender] = list;
    this.save(now);
  }

  save(now = Date.now()) {
    if (!this.file) return;
    for (const [id, t] of Object.entries(this.data.processed)) {
      if (now - t > KEEP_PROCESSED_MS) delete this.data.processed[id];
    }
    for (const [sender, list] of Object.entries(this.data.replies)) {
      const fresh = list.filter((t) => now - t < DAY_MS);
      if (fresh.length) this.data.replies[sender] = fresh;
      else delete this.data.replies[sender];
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}
