// Pure 3-way merge for a markdown note: split YAML frontmatter FIRST (per-key
// last-write-wins + set-union for list keys), diff3 the BODY only, emit standard
// conflict markers on a body overlap. Frontmatter NEVER reaches diff3 - a marker
// inside `---` corrupts the note (yaml.load throws / silent body-swallow). Pure
// (3 strings in, {text,clean} out) → no git/fs deps → unit-testable.
import yaml from 'js-yaml';
import diff3Merge from 'diff3';

type Fm = Record<string, unknown>;
const LINEBREAKS = /^.*(\r?\n|$)/gm;
const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function splitFm(t: string): { fm: Fm; body: string } {
  const m = t.match(FM);
  if (!m) return { fm: {}, body: t };
  return { fm: (yaml.load(m[1]) as Fm) ?? {}, body: t.slice(m[0].length) };
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function ts(fm: Fm): number | null {
  const v = fm['updated'] ?? fm['modified'];
  const n = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(n) ? null : n;
}

// both-changed scalar: newer doc-level `updated`/`modified` wins; absent → theirs
// (remote) wins, a deterministic tiebreak. Per-key timestamps are a future refinement.
function lwwWinner(key: string, o: Fm, t: Fm): unknown {
  const ot = ts(o);
  const tt = ts(t);
  if (ot != null && tt != null) return ot >= tt ? o[key] : t[key];
  return t[key];
}

function mergeFm(b: Fm, o: Fm, t: Fm): Fm {
  const out: Fm = {};
  for (const k of new Set([...Object.keys(o), ...Object.keys(t)])) {
    const ov = o[k];
    const tv = t[k];
    const bv = b[k];
    if (eq(ov, tv)) {
      out[k] = ov;
      continue;
    }
    if (eq(ov, bv)) {
      out[k] = tv; // only theirs changed
      continue;
    }
    if (eq(tv, bv)) {
      out[k] = ov; // only ours changed
      continue;
    }
    if (Array.isArray(ov) && Array.isArray(tv)) {
      // list keys (tags/aliases) → UNION; LWW would silently drop a tag = data loss
      out[k] = [...new Set([...(ov as unknown[]), ...(tv as unknown[])])];
      continue;
    }
    out[k] = lwwWinner(k, o, t);
  }
  return out;
}

function diff3Body(ours: string, base: string, theirs: string): { body: string; clean: boolean } {
  const result = diff3Merge(
    ours.match(LINEBREAKS) ?? [],
    base.match(LINEBREAKS) ?? [],
    theirs.match(LINEBREAKS) ?? []
  );
  let body = '';
  let clean = true;
  for (const item of result) {
    if ('ok' in item) {
      body += item.ok.join('');
    } else {
      clean = false;
      body +=
        '<<<<<<< ours\n' +
        item.conflict.a.join('') +
        '=======\n' +
        item.conflict.b.join('') +
        '>>>>>>> theirs\n';
    }
  }
  return { body, clean };
}

export function mergeNote(
  base: string,
  ours: string,
  theirs: string
): { text: string; clean: boolean } {
  const b = splitFm(base);
  const o = splitFm(ours);
  const t = splitFm(theirs);
  const fm = mergeFm(b.fm, o.fm, t.fm);
  const { body, clean } = diff3Body(o.body, b.body, t.body); // BODY ONLY
  const dumped = yaml.dump(fm, { lineWidth: -1, sortKeys: false }); // one structural dump, never string-concat
  const fmBlock = Object.keys(fm).length ? `---\n${dumped}---\n` : '';
  return { text: fmBlock + body, clean };
}
