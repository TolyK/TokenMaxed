import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { isMinimizedPayload, LIMITS, minimize, scrubText } from '../src/minimize.ts';
import type { MinimizedRequest, SecretScanner } from '../src/minimize.ts';
import { makeGitleaksScanner } from '../src/node.ts';

const clean: SecretScanner = async () => ({ available: true, hasSecret: false });
const hasSecret: SecretScanner = async () => ({ available: true, hasSecret: true });
const unavailable: SecretScanner = async () => ({ available: false, hasSecret: false });
const throwingScanner: SecretScanner = async () => {
  throw new Error('boom');
};

// A worker payload is only produced from a clearly-safe (public + normal) context.
const base: MinimizedRequest = {
  instruction: 'write a function',
  category: 'codegen',
  repo_class: 'public',
  sensitivity: 'normal',
};
const safe = { repo_class: 'public', sensitivity: 'normal' } as const;

test('minimize returns a branded, frozen payload for a valid request', async () => {
  const r = await minimize(base, clean);
  assert.ok(r.ok);
  assert.equal(r.payload.instruction, 'write a function');
  assert.equal(r.payload.category, 'codegen');
  assert.ok(Object.isFrozen(r.payload));
  assert.ok(Object.isFrozen(r.payload.attachments));
});

test('scrubText redacts paths (any absolute layout), urls/remotes, and emails', () => {
  assert.equal(scrubText('see /Users/bob/secret/app.ts now'), 'see [path] now');
  // Non-home checkout layouts must also be scrubbed.
  assert.equal(scrubText('in /workspaces/proj/src/a.ts here'), 'in [path] here');
  assert.equal(scrubText('at /private/var/folders/x/y now'), 'at [path] now');
  // One-segment container/devcontainer roots must be scrubbed too.
  assert.equal(scrubText('cd /workspace then build'), 'cd [path] then build');
  assert.equal(scrubText('repo at /repo here'), 'repo at [path] here');
  // Windows drive + UNC/network paths.
  assert.equal(scrubText('open C:\\Users\\bob\\app.ts please'), 'open [path] please');
  assert.equal(scrubText('open \\\\server\\share\\repo\\app.ts please'), 'open [path] please');
  assert.equal(scrubText('clone git@github.com:acme/repo.git please'), 'clone [url] please');
  assert.equal(scrubText('open https://github.com/acme/repo'), 'open [url]');
  assert.equal(scrubText('mail bob@example.com today'), 'mail [email] today');
  // Relative paths / prose are not mangled.
  assert.equal(scrubText('edit src/index.ts and/or this'), 'edit src/index.ts and/or this');
});

test('minimize scrubs the instruction and attachment contents', async () => {
  const req: MinimizedRequest = {
    instruction: 'fix bug in /Users/bob/app/server.ts',
    category: 'bugfix',
    repo_class: 'public',
    sensitivity: 'normal',
    attachments: [{ content: 'remote git@github.com:acme/x.git', provenance: 'host-authored', repo_derived: false }],
  };
  const r = await minimize(req, clean);
  assert.ok(r.ok);
  assert.equal(r.payload.instruction, 'fix bug in [path]');
  assert.equal(r.payload.attachments[0]?.content, 'remote [url]');
});

test('deny-by-default: repo-derived attachment blocked unless public+normal', async () => {
  const repoDerived = (over: Partial<MinimizedRequest>): MinimizedRequest => ({
    instruction: 'do it',
    category: 'bugfix',
    attachments: [{ content: 'code', provenance: 'host-authored', repo_derived: true }],
    ...over,
  });
  // Unknown context (default) ⇒ blocked.
  assert.equal((await minimize(repoDerived({}), clean)).ok, false);
  // Private repo ⇒ blocked.
  assert.equal((await minimize(repoDerived({ repo_class: 'private', sensitivity: 'normal' }), clean)).ok, false);
  // Sensitive ⇒ blocked.
  assert.equal((await minimize(repoDerived({ repo_class: 'public', sensitivity: 'sensitive' }), clean)).ok, false);
  // public + normal ⇒ allowed.
  assert.equal((await minimize(repoDerived({ repo_class: 'public', sensitivity: 'normal' }), clean)).ok, true);
});

test('request-level deny-by-default: even an instruction-only request needs public+normal', async () => {
  // The instruction itself can carry repo material — closing the bypass where
  // private code is placed in the instruction instead of an attachment.
  assert.equal((await minimize({ instruction: 'private code', category: 'bugfix' }, clean)).ok, false); // unknown
  assert.equal(
    (await minimize({ instruction: 'private code', category: 'bugfix', repo_class: 'private', sensitivity: 'normal' }, clean)).ok,
    false,
  );
  assert.equal((await minimize({ instruction: 'scoped ask', category: 'bugfix', ...safe }, clean)).ok, true);
});

test('a non-repo-derived attachment is allowed in a public+normal context', async () => {
  const req: MinimizedRequest = {
    instruction: 'do it',
    category: 'bugfix',
    ...safe,
    attachments: [{ content: 'snippet the user pasted', provenance: 'user-pasted', repo_derived: false }],
  };
  assert.equal((await minimize(req, clean)).ok, true);
});

test('minimize blocks when the secret scanner finds a secret', async () => {
  const r = await minimize(base, hasSecret);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /secret detected/);
});

test('minimize blocks when the secret scanner is unavailable (required-if-present)', async () => {
  const r = await minimize(base, unavailable);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /unavailable/);
});

test('minimize blocks (fail-closed) when the scanner throws', async () => {
  const r = await minimize(base, throwingScanner);
  assert.equal(r.ok, false);
});

test('minimize enforces limits and validates input', async () => {
  assert.equal((await minimize({ instruction: '', category: 'codegen', ...safe }, clean)).ok, false);
  assert.equal((await minimize({ instruction: 'x', category: 'nope' as never, ...safe }, clean)).ok, false);
  assert.equal((await minimize({ instruction: 'a'.repeat(LIMITS.maxInstructionChars + 1), category: 'docs', ...safe }, clean)).ok, false);
  // Too many attachments.
  const many = Array.from({ length: LIMITS.maxAttachments + 1 }, () => ({ content: 'x', provenance: 'host-authored' as const, repo_derived: false }));
  assert.equal((await minimize({ instruction: 'a', category: 'docs', ...safe, attachments: many }, clean)).ok, false);
  // Oversized total (instruction + attachments under per-field caps but over total).
  const big = Array.from({ length: 3 }, () => ({ content: 'a'.repeat(LIMITS.maxAttachmentChars), provenance: 'host-authored' as const, repo_derived: false }));
  assert.equal((await minimize({ instruction: 'a'.repeat(5000), category: 'docs', ...safe, attachments: big }, clean)).ok, false);
  // Bad attachment shape.
  const badShape = { instruction: 'a', category: 'docs' as const, ...safe, attachments: [{ content: 1 } as never] };
  assert.equal((await minimize(badShape, clean)).ok, false);
});

test('makeGitleaksScanner: available when gitleaks present, fail-safe block when absent', async () => {
  const gitleaksInstalled = spawnSync('gitleaks', ['version']).error === undefined;
  const scan = makeGitleaksScanner();
  const result = await scan(['hello world']);
  if (gitleaksInstalled) {
    // Working scanner reports availability (clean text ⇒ no secret).
    assert.equal(result.available, true);
  } else {
    // Missing binary ⇒ unavailable ⇒ minimizer blocks (required-if-present).
    assert.equal(result.available, false);
    assert.equal((await minimize(base, scan)).ok, false);
  }
});

test('isMinimizedPayload recognizes only genuine payloads (spread/clone is rejected)', async () => {
  const r = await minimize(base, clean);
  assert.ok(r.ok);
  assert.equal(isMinimizedPayload(r.payload), true);
  // A spread copy carries the type brand but is NOT the genuine object ⇒ rejected.
  const forged = { ...r.payload, instruction: 'raw repo text' };
  assert.equal(isMinimizedPayload(forged), false);
  assert.equal(isMinimizedPayload({}), false);
  assert.equal(isMinimizedPayload(null), false);
});

test('guard: no `as MinimizedPayload` casts anywhere in source (nominal boundary)', () => {
  const roots = [
    fileURLToPath(new URL('../src', import.meta.url)),
    fileURLToPath(new URL('../../cli/src', import.meta.url)),
  ];
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      // minimize.ts is the brand's home (it documents the rule); the ban is for
      // every OTHER module — none may forge a payload via cast.
      else if (
        entry.name.endsWith('.ts') &&
        entry.name !== 'minimize.ts' &&
        readFileSync(p, 'utf8').includes('as MinimizedPayload')
      ) {
        offenders.push(p);
      }
    }
  };
  for (const root of roots) walk(root);
  assert.deepEqual(offenders, []);
});
