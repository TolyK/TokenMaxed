/**
 * Reads repo-relative files verbatim for offload payloads so a worker/reader
 * lane sees real repo facts instead of hallucinating them.
 *
 * Security boundary — confinement is the critical part:
 *   - requires a real project directory (CLAUDE_PROJECT_DIR); aborts otherwise
 *   - rejects absolute paths
 *   - rejects any `..` traversal segments
 *   - resolves symlinks and rejects any target that escapes the project root
 *   - admits regular files only
 *   - file content is the project dir's, never an off-tree file's
 *
 * The minimizer downstream scrubs + size-bounds + policy-gates the resulting
 * attachments before any egress; private-repo files still require a
 * reader-trust lane and its egress opt-in.
 *
 * Fail-closed: never throws. Bad paths land in `skipped` with a reason.
 * Oversize files are dropped (not silently clipped, and SIZE-gated before the read
 * so a huge file never lands in memory) so callers can excerpt them in the
 * instruction instead of losing the exact fact they meant to attach.
 *
 * Residual (out of scope): a purely LOCAL attacker who can race the filesystem
 * could swap a confined path for an escaping symlink in the window between
 * `realpath` and `stat`/`readFile` (a TOCTOU). That attacker already has local
 * write access to the checkout, so this is not a new exposure for a local dev
 * tool; descriptor-based open/fstat with identity checks would close it if the
 * threat model ever required it.
 */
import { isAbsolute, join, sep } from 'node:path';

import { LIMITS } from '@tokenmaxed/core';
import type { MinimizedAttachment } from '@tokenmaxed/core';

export interface RepoFileReaderDeps {
  /** The repo root (host CLAUDE_PROJECT_DIR). Undefined ⇒ refuse to read (skip all). */
  projectDir?: string;
  /** Resolve symlinks to a real absolute path; THROWS if the path does not exist. */
  realpath: (p: string) => string;
  /** Read a file as utf8. */
  readFile: (p: string) => string;
  /** Stat a (realpath-resolved) path: regular-file flag + byte size. THROWS on error. */
  stat: (p: string) => { isFile: boolean; size: number };
}

export interface SkippedFile {
  path: string;
  reason: string;
}
export interface RepoFileResult {
  attachments: MinimizedAttachment[];
  skipped: SkippedFile[];
}

export function readRepoFiles(paths: readonly string[], deps: RepoFileReaderDeps): RepoFileResult {
  const attachments: MinimizedAttachment[] = [];
  const skipped: SkippedFile[] = [];

  if (!deps.projectDir) {
    for (const p of paths) {
      skipped.push({ path: p, reason: 'no project directory (CLAUDE_PROJECT_DIR) — cannot read repo files safely' });
    }
    return { attachments, skipped };
  }

  let rootReal: string;
  try {
    rootReal = deps.realpath(deps.projectDir);
  } catch {
    for (const p of paths) {
      skipped.push({ path: p, reason: 'project directory not found' });
    }
    return { attachments, skipped };
  }

  for (let i = 0; i < paths.length; i++) {
    const p = paths[i]!;

    if (i >= LIMITS.maxAttachments) {
      skipped.push({ path: p, reason: `too many files (max ${LIMITS.maxAttachments})` });
      continue;
    }
    if (isAbsolute(p)) {
      skipped.push({ path: p, reason: 'must be a repo-relative path' });
      continue;
    }
    // Reject `..` on the RAW segments (before any normalization) — `src/../x`
    // normalizes to an in-repo path, but the rule is "no `..` traversal" and a
    // caller naming `..` is either confused or probing; don't silently honor it.
    if (p.split(/[/\\]/).includes('..')) {
      skipped.push({ path: p, reason: 'path escapes the repo (..)' });
      continue;
    }

    const abs = join(rootReal, p);
    let real: string;
    try {
      real = deps.realpath(abs);
    } catch {
      skipped.push({ path: p, reason: 'not found' });
      continue;
    }
    if (real !== rootReal && !real.startsWith(rootReal + sep)) {
      skipped.push({ path: p, reason: 'resolves outside the repo' });
      continue;
    }

    // Stat is wrapped (a race/removal/permission error must NOT escape — fail-closed
    // skip) and SIZE-gates before reading so a huge file never lands in memory.
    let st: { isFile: boolean; size: number };
    try {
      st = deps.stat(real);
    } catch {
      skipped.push({ path: p, reason: 'unreadable' });
      continue;
    }
    if (!st.isFile) {
      skipped.push({ path: p, reason: 'not a regular file' });
      continue;
    }
    if (st.size > LIMITS.maxAttachmentChars) {
      skipped.push({ path: p, reason: `too large (> ${LIMITS.maxAttachmentChars} chars) — excerpt it in the instruction instead` });
      continue;
    }

    let content: string;
    try {
      content = deps.readFile(real);
    } catch {
      skipped.push({ path: p, reason: 'unreadable' });
      continue;
    }
    if (content.length > LIMITS.maxAttachmentChars) {
      skipped.push({ path: p, reason: `too large (> ${LIMITS.maxAttachmentChars} chars) — excerpt it in the instruction instead` });
      continue;
    }

    attachments.push({ content, provenance: 'host-authored', repo_derived: true });
  }

  return { attachments, skipped };
}
