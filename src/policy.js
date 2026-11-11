/**
 * Parse the policy markdown into sections. Each section starts with
 *   ## [EXP-1] Title
 * The IDs are what the reply bot must cite, and what we check against.
 */
export function parsePolicy(markdown) {
  const sections = [];
  let current = null;

  for (const line of String(markdown).split(/\r?\n/)) {
    const m = line.match(/^##\s+\[([A-Za-z]+-\d+)\]\s+(.+?)\s*$/);
    if (m) {
      current = { id: m[1].toUpperCase(), title: m[2], body: '' };
      sections.push(current);
    } else if (current) {
      current.body += `${line}\n`;
    }
  }

  if (!sections.length) {
    throw new Error('Policy has no sections. Each section must start with "## [EXP-1] Title".');
  }
  for (const s of sections) s.body = s.body.trim();

  const ids = new Set(sections.map((s) => s.id));
  if (ids.size !== sections.length) throw new Error('Policy has duplicate section IDs.');

  const text = sections.map((s) => `[${s.id}] ${s.title}\n${s.body}`).join('\n\n');
  return { sections, ids, text };
}
