import type { TaskCategory } from './types.ts';

export const MIN_CLASSIFY_CONFIDENCE = 0.5;
export const CLASSIFY_FALLBACK_CATEGORY: TaskCategory = 'feature';

export interface Classification {
  category: TaskCategory;
  confidence: number;
  scores: Partial<Record<TaskCategory, number>>;
}

const CATEGORY_ORDER: TaskCategory[] = [
  'boilerplate',
  'bugfix',
  'refactor',
  'explain',
  'feature',
  'codegen',
  'docs',
];

const SIGNALS: Record<TaskCategory, string[]> = {
  bugfix: [
    'fix',
    'bug',
    'error',
    'crash',
    'broken',
    'regression',
    'failing test',
    'stack trace',
    'exception',
    'npe',
    'off-by-one',
  ],
  refactor: [
    'refactor',
    'rename',
    'extract',
    'inline',
    'restructure',
    'clean up',
    'deduplicate',
    'simplify code',
    'simplify',
    'move function',
    'move method',
    'move file',
    'move code',
    'move the function',
    'move the method',
    'move the file',
    'move the code',
  ],
  docs: [
    'document',
    'documentation',
    'readme',
    'changelog',
    'docstring',
    'jsdoc',
    'code comment',
    'write docs',
  ],
  explain: [
    'explain',
    'how does',
    'what does',
    'walk through',
    'understand',
    'trace through',
    'summarize the code',
  ],
  codegen: [
    'generate',
    'scaffold',
    'write a function',
    'write a script',
    'write a test',
    'write a component',
    'write a',
    'implement a',
    'create a function',
    'create a class',
    'create a',
  ],
  boilerplate: [
    'boilerplate',
    'stub',
    'skeleton',
    'config file',
    'setup file',
    'plumbing',
    'wiring',
    'repetitive',
  ],
  feature: [
    'add',
    'implement',
    'build',
    'feature',
    'support for',
    'new endpoint',
    'new page',
    'new command',
    'new flag',
    'new',
  ],
};

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function classifyTask(text: string): Classification {
  const scores: Record<TaskCategory, number> = {
    boilerplate: 0,
    bugfix: 0,
    refactor: 0,
    explain: 0,
    feature: 0,
    codegen: 0,
    docs: 0,
  };

  const lowerText = text.toLowerCase();

  // Score each category by counting occurrences of each signal phrase.
  for (const category of CATEGORY_ORDER) {
    const phrases = SIGNALS[category];
    for (const phrase of phrases) {
      const escaped = escapeRegExp(phrase);
      const regex = new RegExp(`\\b${escaped}\\b`, 'g');
      const matches = lowerText.match(regex);
      if (matches) {
        scores[category] += matches.length;
      }
    }
  }

  // Find the top score and the category with the top score.
  let topScore = 0;
  let topCategory: TaskCategory | null = null;

  for (const category of CATEGORY_ORDER) {
    const score = scores[category];
    if (score > topScore) {
      topScore = score;
      topCategory = category;
    }
  }

  // Find the second-best score.
  let secondScore = 0;
  for (const category of CATEGORY_ORDER) {
    if (category === topCategory) {
      continue;
    }
    const score = scores[category];
    if (score > secondScore) {
      secondScore = score;
    }
  }

  // If top score is 0, confidence is 0 and category is fallback
  if (topScore === 0) {
    return {
      category: CLASSIFY_FALLBACK_CATEGORY,
      confidence: 0,
      scores,
    };
  }

  const confidence = Math.max(0, Math.min(1, (topScore - secondScore) / topScore));

  return {
    category: topCategory!,
    confidence,
    scores,
  };
}
