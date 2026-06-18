// Pure (no git, no fs) helpers for turning conventional-commit subjects into the About page's ReleaseNote[]
// shape. Kept dependency-free + side-effect-free so it's unit-testable (scripts/release-notes-core.spec.ts);
// the git/fs I/O lives in gen-release-notes.mjs. See docs + the plan: the About changelog is GENERATED from
// the git tags + commits at build time, never hand-written.

/** @typedef {{ version: string, title: string, items: string[] }} ReleaseNote */

// Conventional-commit types we surface to users, and the group label / item prefix each gets. Everything else
// (chore, ci, build, test, docs, style, refactor, deps bumps, merges) is noise → dropped from release notes.
const TYPE_GROUP = {
  feat: { rank: 0, prefix: '' },
  fix: { rank: 1, prefix: 'Fix: ' },
  perf: { rank: 1, prefix: 'Fix: ' },
};

const MAX_ITEMS = 12;

/**
 * Parse one commit subject line. Returns null for anything that isn't a user-facing conventional commit
 * (unknown/noise type, merge commit, or unparseable).
 * @param {string} subject
 * @returns {{ type: string, scope: string|null, summary: string, pr: string|null } | null}
 */
export function parseCommitSubject(subject) {
  const line = (subject ?? '').trim();
  if (!line || line.startsWith('Merge ')) return null;
  // type(scope)?!?: summary (#PR)?   — summary is non-greedy so the trailing (#NN) is split off, not kept.
  // Build-time only, on one trimmed commit subject from our own git history (bounded, trusted) — no ReDoS surface.
  // eslint-disable-next-line security/detect-unsafe-regex
  const m = /^(\w+)(?:\(([^)]+)\))?!?:\s*(.+?)(?:\s*\(#(\d+)\))?$/.exec(line);
  if (!m) return null;
  const [, type, scope, summary, pr] = m;
  if (!(type in TYPE_GROUP)) return null;
  const cleaned = summary.trim();
  if (!cleaned) return null;
  return { type, scope: scope ?? null, summary: cleaned, pr: pr ?? null };
}

/**
 * Build a single release entry from a tag's commit subjects. Returns null when nothing user-facing remains
 * (so empty/chore-only releases don't produce a blank card).
 * @param {{ version: string, date: string, subjects: string[] }} input
 * @returns {ReleaseNote | null}
 */
export function buildReleaseEntry({ version, date, subjects }) {
  const parsed = (subjects ?? [])
    .map(parseCommitSubject)
    .filter((c) => c !== null)
    // feat before fix; stable within a group (input is newest-first from git log).
    .sort((a, b) => TYPE_GROUP[a.type].rank - TYPE_GROUP[b.type].rank);

  if (parsed.length === 0) return null;

  const allItems = parsed.map((c) => {
    const ref = c.pr ? ` (#${c.pr})` : '';
    return `${TYPE_GROUP[c.type].prefix}${c.summary}${ref}`;
  });

  const items =
    allItems.length > MAX_ITEMS
      ? [...allItems.slice(0, MAX_ITEMS), `…and ${allItems.length - MAX_ITEMS} more changes`]
      : allItems;

  return { version, title: date, items };
}

/**
 * Build the full ReleaseNote[] from per-tag inputs (already newest-first). Drops releases with no user-facing
 * changes. The version string is expected pre-normalized (e.g. "v0.4.0").
 * @param {{ version: string, date: string, subjects: string[] }[]} tags
 * @returns {ReleaseNote[]}
 */
export function buildReleaseNotes(tags) {
  return (tags ?? []).map(buildReleaseEntry).filter((n) => n !== null);
}

/** Normalize a git tag to a display version: strip a leading `aws-` experiment prefix and a leading `v`. */
export function normalizeTagVersion(tag) {
  return (tag ?? '').trim().replace(/^aws-/, '').replace(/^v/, '');
}

/**
 * The git `refs/tags/*` globs to scan for a given triggering tag. The changelog must stay within ONE release
 * lineage: prod tags are `v*` (cd.yml), the experiment is `aws-v*` (cd-aws.yml). Their version lines are
 * independent, so a prod build must not treat a reachable `aws-v*` tag as a previous release (and vice versa).
 * Unknown/empty (local/dev, no CD trigger) → both namespaces. Order matters: `aws-v…` also starts with no `v`.
 * @param {string} releaseTag e.g. "v0.4.0", "aws-v0.4.0", or "" when run outside CD
 * @returns {string[]}
 */
export function tagRefGlobs(releaseTag) {
  const tag = (releaseTag ?? '').trim();
  if (tag.startsWith('aws-v')) return ['refs/tags/aws-v*'];
  if (tag.startsWith('v')) return ['refs/tags/v*'];
  return ['refs/tags/v*', 'refs/tags/aws-v*'];
}
