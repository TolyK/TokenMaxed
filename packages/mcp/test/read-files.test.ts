/**
 * Tests for the security-critical repo-file reader: path confinement (absolute /
 * `..` / symlink-escape rejected, regular-file-only, project-dir-confined), the
 * no-project-dir refusal, the oversize-drop, and the count cap. Pure over a fake fs.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LIMITS } from '@tokenmaxed/core';

import { readRepoFiles } from '../src/read-files.ts';
import type { RepoFileReaderDeps } from '../src/read-files.ts';

/** In-memory fake fs rooted at /repo; `files` keyed by absolute real path. */
function fakeDeps(
  files: Record<string, string>,
  opts: {
    projectDir?: string | undefined;
    realRoot?: string;
    symlinks?: Record<string, string>;
    stat?: (p: string) => { isFile: boolean; size: number };
  } = {},
): RepoFileReaderDeps {
  const realRoot = opts.realRoot ?? '/repo';
  const links = opts.symlinks ?? {};
  return {
    projectDir: 'projectDir' in opts ? opts.projectDir : '/repo',
    realpath: (p: string) => {
      if (p === '/repo') return realRoot;
      if (p in links) return links[p]!;
      if (p in files) return p;
      throw new Error('ENOENT');
    },
    readFile: (p: string) => {
      const c = files[p];
      if (c === undefined) throw new Error('ENOENT');
      return c;
    },
    stat: opts.stat ?? ((p: string) => ({ isFile: p in files, size: (files[p] ?? '').length })),
  };
}

test('reads a confined repo file verbatim', () => {
  const result = readRepoFiles(['video_models.py'], fakeDeps({ '/repo/video_models.py': 'PRICE=0.18' }));
  assert.deepEqual(result.attachments, [{ content: 'PRICE=0.18', provenance: 'host-authored', repo_derived: true }]);
  assert.deepEqual(result.skipped, []);
});

test('rejects an absolute path', () => {
  const r = readRepoFiles(['/etc/passwd'], fakeDeps({}));
  assert.equal(r.attachments.length, 0);
  assert.match(r.skipped[0]!.reason, /repo-relative/);
});

test('rejects a .. traversal', () => {
  const r = readRepoFiles(['../secrets.txt'], fakeDeps({}));
  assert.equal(r.attachments.length, 0);
  assert.match(r.skipped[0]!.reason, /escapes the repo/);
});

test('rejects a symlink that escapes the repo', () => {
  // /repo/link is a symlink whose realpath is /etc/shadow (outside the root).
  const deps = fakeDeps({}, { symlinks: { '/repo/link': '/etc/shadow' }, stat: () => ({ isFile: true, size: 1 }) });
  const r = readRepoFiles(['link'], deps);
  assert.equal(r.attachments.length, 0);
  assert.match(r.skipped[0]!.reason, /outside the repo/);
});

test('rejects a normalized-away .. segment (raw-segment check)', () => {
  // `src/../secret.py` normalizes to an in-repo path, but a raw `..` segment is rejected.
  const r = readRepoFiles(['src/../secret.py'], fakeDeps({ '/repo/secret.py': 'X' }));
  assert.equal(r.attachments.length, 0);
  assert.match(r.skipped[0]!.reason, /escapes the repo/);
});

test('never throws when stat fails (race/removal/permission) — skips fail-closed', () => {
  const deps = fakeDeps({ '/repo/x.py': 'ok' }, { stat: () => { throw new Error('EACCES'); } });
  const r = readRepoFiles(['x.py'], deps);
  assert.equal(r.attachments.length, 0);
  assert.match(r.skipped[0]!.reason, /unreadable/);
});

test('size-gates a huge file BEFORE reading it into memory', () => {
  let read = false;
  const deps = fakeDeps(
    { '/repo/huge.py': 'small-content-but-stat-says-huge' },
    { stat: () => ({ isFile: true, size: LIMITS.maxAttachmentChars + 1 }) },
  );
  const guarded: RepoFileReaderDeps = { ...deps, readFile: (p) => { read = true; return deps.readFile(p); } };
  const r = readRepoFiles(['huge.py'], guarded);
  assert.equal(r.attachments.length, 0);
  assert.match(r.skipped[0]!.reason, /too large/);
  assert.equal(read, false); // never read into memory
});

test('skips a missing file', () => {
  const r = readRepoFiles(['nope.py'], fakeDeps({}));
  assert.equal(r.attachments.length, 0);
  assert.match(r.skipped[0]!.reason, /not found/);
});

test('refuses everything when projectDir is undefined', () => {
  const r = readRepoFiles(['a.py', 'b.py'], fakeDeps({}, { projectDir: undefined }));
  assert.equal(r.attachments.length, 0);
  assert.equal(r.skipped.length, 2);
  assert.match(r.skipped[0]!.reason, /no project directory/);
});

test('drops an oversize file (never silently clips)', () => {
  const big = 'x'.repeat(LIMITS.maxAttachmentChars + 1);
  const r = readRepoFiles(['big.py'], fakeDeps({ '/repo/big.py': big }));
  assert.equal(r.attachments.length, 0);
  assert.match(r.skipped[0]!.reason, /too large/);
});

test('caps the number of files at LIMITS.maxAttachments', () => {
  const files: Record<string, string> = {};
  const paths: string[] = [];
  for (let i = 0; i < LIMITS.maxAttachments + 1; i++) {
    files[`/repo/f${i}.py`] = `c${i}`;
    paths.push(`f${i}.py`);
  }
  const r = readRepoFiles(paths, fakeDeps(files));
  assert.equal(r.attachments.length, LIMITS.maxAttachments);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0]!.reason, /too many files/);
});
