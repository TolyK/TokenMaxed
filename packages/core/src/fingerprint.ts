import type { RouteContext } from './types.ts';

export interface TaskFingerprint {
  language: { lang: string; confidence: number };
  contextSizeBand: 'small' | 'medium' | 'large' | 'xlarge';
  toolNeed: 'low' | 'medium' | 'high';
  planVsImpl: 'plan' | 'mixed' | 'impl';
  securitySensitive: boolean;
  blastRadius: 'narrow' | 'moderate' | 'wide';
}

const LANGUAGES = [
  'ts', 'js', 'python', 'go', 'rust', 'java', 'c', 'cpp', 'csharp', 'ruby', 'php', 'shell', 'sql'
] as const;

type SupportedLanguage = typeof LANGUAGES[number];

const LANG_PATTERNS: Record<SupportedLanguage, { fenced: RegExp[]; ext: RegExp[]; kw: RegExp[] }> = {
  ts: {
    fenced: [/\b(ts|typescript)\b/i],
    ext: [/\.(ts|tsx)\b/i],
    kw: [/\btypescript\b/i],
  },
  js: {
    fenced: [/\b(js|javascript)\b/i],
    ext: [/\.(js|jsx|mjs|cjs)\b/i],
    kw: [/\bjavascript\b/i],
  },
  python: {
    fenced: [/\b(py|python)\b/i],
    ext: [/\.(py|pyw)\b/i],
    kw: [/\bpython\b/i],
  },
  go: {
    fenced: [/\b(go|golang)\b/i],
    ext: [/\.go\b/i],
    kw: [/\bgolang\b/i, /\bgo lang\b/i, /\bgo code\b/i],
  },
  rust: {
    fenced: [/\b(rs|rust)\b/i],
    ext: [/\.rs\b/i],
    kw: [/\brustlang\b/i, /\brust lang\b/i, /\brust code\b/i, /\brust\b/i],
  },
  java: {
    fenced: [/\bjava\b/i],
    ext: [/\.(java|jar)\b/i],
    kw: [/\bjava\b/i],
  },
  c: {
    fenced: [/^c$/i],
    ext: [/\.(c|h)\b/i],
    kw: [/\bc code\b/i],
  },
  cpp: {
    fenced: [/^(cpp|c\+\+|cc)$/i, /\b(cpp|cc)\b/i, /\bc\+\+(?!\w)/i],
    ext: [/\.(cpp|hpp|cc|cxx)\b/i],
    kw: [/\bc\+\+(?!\w)/i, /\bcpp\b/i],
  },
  csharp: {
    fenced: [/^(csharp|cs|c#)$/i, /\b(csharp|cs)\b/i, /\bc#(?!\w)/i],
    ext: [/\.cs\b/i],
    kw: [/\bc#(?!\w)/i, /\bcsharp\b/i],
  },
  ruby: {
    fenced: [/\b(rb|ruby)\b/i],
    ext: [/\.rb\b/i],
    kw: [/\bruby\b/i],
  },
  php: {
    fenced: [/\bphp\b/i],
    ext: [/\.php\b/i],
    kw: [/\bphp\b/i],
  },
  shell: {
    fenced: [/\b(shell|sh|bash|zsh)\b/i],
    ext: [/\.(sh|bash|zsh)\b/i],
    kw: [/\bshell script\b/i, /\bbash script\b/i, /\bshell command\b/i, /\bterminal command\b/i, /\bbash\b/i, /\bzsh\b/i],
  },
  sql: {
    fenced: [/\bsql\b/i],
    ext: [/\.sql\b/i],
    kw: [/\bsql\b/i, /\bpostgresql\b/i, /\bmysql\b/i, /\bsqlite\b/i],
  },
};

/** Bounded allocation-free scanning match counter */
function countMatches(regex: RegExp, str: string): number {
  const flags = (regex.ignoreCase ? 'i' : '') + 'g';
  const globalRegex = new RegExp(regex.source, flags);
  let count = 0;
  while (globalRegex.test(str)) {
    count++;
    if (globalRegex.lastIndex === 0) {
      break;
    }
  }
  return count;
}

export function fingerprintTask(text: string, opts?: { referencedFileCount?: number }): TaskFingerprint {
  const originalLen = text.length;
  const fileCount = opts?.referencedFileCount ?? 0;

  // contextSizeBand is computed from the original unbounded input size + fileCount
  let contextSizeBand: 'small' | 'medium' | 'large' | 'xlarge' = 'small';
  if (originalLen > 50000 || fileCount > 10) {
    contextSizeBand = 'xlarge';
  } else if (originalLen > 15000 || fileCount > 4) {
    contextSizeBand = 'large';
  } else if (originalLen > 3000 || fileCount > 1) {
    contextSizeBand = 'medium';
  } else {
    contextSizeBand = 'small';
  }

  // Cap pattern scanned length to 64KB to avoid memory exhaustion from massive texts
  const MAX_SCAN_LEN = 65536;
  const scanned = text.length > MAX_SCAN_LEN ? text.slice(0, MAX_SCAN_LEN) : text;
  const trimmed = scanned.trim();

  if (!trimmed) {
    return {
      language: { lang: 'unknown', confidence: 0 },
      contextSizeBand,
      toolNeed: 'low',
      planVsImpl: 'impl',
      securitySensitive: false,
      blastRadius: 'narrow',
    };
  }

  const lowerText = trimmed.toLowerCase();

  // Find fenced code block tags (capped at 100 to avoid regex runaway)
  const fencedTags: string[] = [];
  const fencedRegex = /```(\S+)/g;
  let match;
  let fencedCount = 0;
  while ((match = fencedRegex.exec(trimmed)) !== null && fencedCount++ < 100) {
    if (match[1]) {
      fencedTags.push(match[1].toLowerCase());
    }
  }

  const scores: Record<SupportedLanguage, number> = {
    ts: 0, js: 0, python: 0, go: 0, rust: 0, java: 0, c: 0, cpp: 0, csharp: 0, ruby: 0, php: 0, shell: 0, sql: 0
  };

  for (const lang of LANGUAGES) {
    const patterns = LANG_PATTERNS[lang];

    // Check fenced tags
    for (const tag of fencedTags) {
      for (const pat of patterns.fenced) {
        if (pat.test(tag)) {
          scores[lang] += 10;
        }
      }
    }

    // Check extensions
    for (const pat of patterns.ext) {
      const matchCount = countMatches(pat, lowerText);
      if (matchCount > 0) {
        scores[lang] += matchCount * 5;
      }
    }

    // Check keywords
    for (const pat of patterns.kw) {
      const matchCount = countMatches(pat, lowerText);
      if (matchCount > 0) {
        scores[lang] += matchCount * 3;
      }
    }
  }

  let topScore = 0;
  let topLang: SupportedLanguage | null = null;
  for (const lang of LANGUAGES) {
    if (scores[lang] > topScore) {
      topScore = scores[lang];
      topLang = lang;
    }
  }

  let secondScore = 0;
  for (const lang of LANGUAGES) {
    if (lang === topLang) continue;
    if (scores[lang] > secondScore) {
      secondScore = scores[lang];
    }
  }

  let language: { lang: string; confidence: number } = { lang: 'unknown', confidence: 0 };
  if (topScore > 0 && topLang) {
    const separation = (topScore - secondScore) / topScore;
    const strength = Math.min(1, topScore / 15);
    const confidence = Math.max(0, Math.min(1, separation * strength));
    // Require confidence to be at least 0.15 to prevent noise/ties from overclaiming
    if (confidence >= 0.15) {
      language = { lang: topLang, confidence };
    } else {
      language = { lang: 'unknown', confidence: 0 };
    }
  }

  // 3. toolNeed
  const highNeedKeywords = [
    'npm run', 'npm install', 'npm test', 'cargo test', 'pytest', 'go test', 'run command',
    'run script', 'run tests', 'compile', 'docker', 'db migrate', 'npm build', 'webpack',
    'vite', 'execute', 'yarn test', 'yarn build', 'pip install', 'pip3 install'
  ];
  const medNeedKeywords = [
    'run', 'test', 'build', 'search', 'browse', 'migrate', 'grep', 'lint', 'typecheck',
    'format', 'verify', 'exec'
  ];

  let toolScore = 0;
  for (const kw of highNeedKeywords) {
    const regex = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    toolScore += countMatches(regex, trimmed) * 3;
  }
  for (const kw of medNeedKeywords) {
    const regex = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    toolScore += countMatches(regex, trimmed) * 1;
  }

  let toolNeed: 'low' | 'medium' | 'high' = 'low';
  if (toolScore >= 5) {
    toolNeed = 'high';
  } else if (toolScore >= 1) {
    toolNeed = 'medium';
  }

  // 4. planVsImpl
  const planKeywords = ['design', 'spec', 'architect', 'plan', 'proposal', 'blueprint', 'diagram', 'concept', 'rfc', 'outline', 'workflow', 'structure', 'flowchart'];
  const implKeywords = ['write', 'edit', 'implement', 'fix', 'code', 'refactor', 'create', 'add', 'delete', 'update', 'modify', 'bugfix', 'patch', 'tweak', 'clean up'];

  let planScore = 0;
  let implScore = 0;
  for (const kw of planKeywords) {
    const regex = new RegExp(`\\b${kw}\\b`, 'i');
    planScore += countMatches(regex, trimmed);
  }
  for (const kw of implKeywords) {
    const regex = new RegExp(`\\b${kw}\\b`, 'i');
    implScore += countMatches(regex, trimmed);
  }

  let planVsImpl: 'plan' | 'mixed' | 'impl' = 'impl';
  if (planScore > 0 && implScore > 0) {
    planVsImpl = 'mixed';
  } else if (planScore > 0) {
    planVsImpl = 'plan';
  } else {
    planVsImpl = 'impl';
  }

  // 5. securitySensitive
  const secKeywords = ['auth', 'crypto', 'secret', 'token', 'password', 'permission', 'pii', 'credential', 'jwt', 'encrypt', 'decrypt', 'hash', 'login', 'oauth', 'session', 'api key', 'private key', 'ssl', 'tls', 'cert'];
  let securitySensitive = false;
  for (const kw of secKeywords) {
    const regex = new RegExp(`\\b${kw}\\b`, 'i');
    if (regex.test(trimmed)) {
      securitySensitive = true;
      break;
    }
  }

  // 6. blastRadius
  const wideKeywords = ['rename everywhere', 'migration', 'all files', 'schema change', 'every', 'global', 'cross-cutting', 'breaking change', 'database schema', 'restructure whole', 'refactor all'];
  const modKeywords = ['rename', 'directory', 'multiple files', 'components', 'package', 'module', 'across', 'impact'];
  const narrowKeywords = ['single file', 'local', 'tweak', 'one line', 'helper', 'isolated', 'internal', 'private'];

  let wideScore = 0;
  let modScore = 0;
  let narrowScore = 0;

  for (const kw of wideKeywords) {
    const regex = new RegExp(`\\b${kw}\\b`, 'i');
    wideScore += countMatches(regex, trimmed) * 3;
  }
  for (const kw of modKeywords) {
    const regex = new RegExp(`\\b${kw}\\b`, 'i');
    modScore += countMatches(regex, trimmed) * 1;
  }
  for (const kw of narrowKeywords) {
    const regex = new RegExp(`\\b${kw}\\b`, 'i');
    narrowScore += countMatches(regex, trimmed) * 1;
  }

  let blastRadius: 'narrow' | 'moderate' | 'wide' = 'narrow';
  if (wideScore > 0) {
    blastRadius = 'wide';
  } else if (modScore > 0) {
    blastRadius = 'moderate';
  } else {
    blastRadius = 'narrow';
  }

  return {
    language,
    contextSizeBand,
    toolNeed,
    planVsImpl,
    securitySensitive,
    blastRadius,
  };
}
