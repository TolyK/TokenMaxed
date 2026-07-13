import type {
  RouteContext,
  Policy,
  TaskCategory,
  DifficultyBucket,
  Task,
  ObservedCapability,
  ObservedCapabilityByLane,
  ObservedCapabilityByModel,
  ObservedCapabilityByModelDifficulty,
  Lane,
} from './types.ts';
import type { LedgerEvent } from './ledger.ts';
import { routeDecide, resolveLaneModelKey } from './route.ts';
import { capabilityInterval, evidenceFreshnessDays, contributingOutcomes } from './feedback.ts';

export type BacktestPolicy = NonNullable<RouteContext['routingPolicy']>;

export interface BacktestEvidence {
  rate: number;
  n: number;
  lo?: number;
  hi?: number;
  freshnessDays?: number;
}

export interface BacktestDifference {
  category: TaskCategory;
  difficulty: DifficultyBucket | undefined;
  workloadSharePercent: number;
  pickA: string;
  pickB: string;
  evidenceA?: BacktestEvidence;
  evidenceB?: BacktestEvidence;
  comparison: 'favors_A' | 'favors_B' | 'neutral' | 'insufficient_evidence';
}

export interface BacktestSummary {
  diffPercent: number;
  differences: BacktestDifference[];
  netSignal: 'evidence favors A' | 'evidence favors B' | 'neutral / insufficient';
}

export const MIN_SIGNIFICANT_N = 5;

function isValidObserved(obs: ObservedCapability | undefined): obs is ObservedCapability {
  if (!obs) return false;
  const { rate, n } = obs;
  return (
    Number.isFinite(rate) &&
    rate >= 0 &&
    rate <= 1 &&
    Number.isFinite(n) &&
    n >= 0
  );
}

function sanitizeEvidence(obs: ObservedCapability, lo?: number, hi?: number, freshness?: number): BacktestEvidence | undefined {
  const rate = Number.isFinite(obs.rate) && obs.rate >= 0 && obs.rate <= 1 ? obs.rate : 0;
  const n = Number.isFinite(obs.n) && obs.n >= 0 ? obs.n : 0;

  if (n <= 0) return undefined;

  const cleanLo = lo !== undefined && Number.isFinite(lo) && lo >= 0 && lo <= 1 ? lo : undefined;
  const cleanHi = hi !== undefined && Number.isFinite(hi) && hi >= 0 && hi <= 1 ? hi : undefined;
  const cleanFresh = freshness !== undefined && Number.isFinite(freshness) && freshness >= 0 ? freshness : undefined;

  return {
    rate,
    n,
    ...(cleanLo !== undefined ? { lo: cleanLo } : {}),
    ...(cleanHi !== undefined ? { hi: cleanHi } : {}),
    ...(cleanFresh !== undefined ? { freshnessDays: cleanFresh } : {}),
  };
}

export function observedForLaneWithDifficulty(
  lane: Lane,
  category: TaskCategory,
  difficulty: DifficultyBucket | undefined,
  laneOverlay?: ObservedCapabilityByLane,
  modelOverlay?: ObservedCapabilityByModel,
  difficultyOverlay?: ObservedCapabilityByModelDifficulty,
  onResolveSource?: (source: 'difficulty' | 'model' | 'lane') => void
): ObservedCapability | undefined {
  const modelKey = resolveLaneModelKey(lane);
  if (difficulty && difficultyOverlay) {
    const cell = difficultyOverlay[modelKey]?.[category]?.[difficulty];
    if (cell) {
      onResolveSource?.('difficulty');
      return cell;
    }
  }
  if (modelOverlay) {
    const cell = modelOverlay[modelKey]?.[category];
    if (cell) {
      onResolveSource?.('model');
      return cell;
    }
    return undefined; // If modelOverlay exists but specific cell is missing, do not fall back.
  }
  const cell = laneOverlay?.[lane.id]?.[category];
  if (cell) {
    onResolveSource?.('lane');
    return cell;
  }
  return undefined;
}

/**
 * Pure offline backtest policy comparison:
 * Replays routing decisions over the historical workload of ledger events under
 * two policies (policyA vs policyB), using the current lanes/config/overlays.
 */
export function analyzeBacktest(
  events: readonly LedgerEvent[],
  baseCtx: RouteContext,
  policy: Policy,
  now: number,
  opts: {
    policyA: BacktestPolicy;
    policyB: BacktestPolicy;
  }
): BacktestSummary {
  const { policyA, policyB } = opts;

  // 1. Build difficulty map from outcomes
  const difficultyMap = new Map<string, DifficultyBucket>();
  for (const e of events) {
    if (e.event_type === 'outcome' && e.task_id && e.difficulty) {
      difficultyMap.set(`${e.task_id}:${e.attempt}`, e.difficulty);
    }
  }

  // 2. Count volume per (category × difficulty) for non-native task legs
  const workloadCells = new Map<string, { category: TaskCategory; difficulty?: DifficultyBucket; count: number }>();
  let totalDecisions = 0;

  for (const e of events) {
    if (e.event_type === 'task') {
      if (e.status !== 'native') {
        const difficulty = difficultyMap.get(`${e.task_id}:${e.attempt}`);
        const key = `${e.category}:${difficulty || ''}`;
        const existing = workloadCells.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          workloadCells.set(key, { category: e.category, difficulty, count: 1 });
        }
        totalDecisions += 1;
      }
    }
  }

  // If there are no decisions, return a graceful empty summary (finite-safe)
  if (totalDecisions === 0) {
    return {
      diffPercent: 0,
      differences: [],
      netSignal: 'neutral / insufficient',
    };
  }

  const sanitizeObservedCapability = (overlay?: ObservedCapabilityByLane): ObservedCapabilityByLane | undefined => {
    if (!overlay) return undefined;
    const clean: ObservedCapabilityByLane = {};
    for (const [laneId, categories] of Object.entries(overlay)) {
      if (!categories) continue;
      const cleanCats: Partial<Record<TaskCategory, ObservedCapability>> = {};
      for (const [cat, obs] of Object.entries(categories)) {
        if (isValidObserved(obs)) {
          cleanCats[cat as TaskCategory] = obs;
        }
      }
      clean[laneId] = cleanCats;
    }
    return clean;
  };

  const sanitizeObservedCapabilityByModel = (overlay?: ObservedCapabilityByModel): ObservedCapabilityByModel | undefined => {
    if (!overlay) return undefined;
    const clean: ObservedCapabilityByModel = {};
    for (const [model, categories] of Object.entries(overlay)) {
      if (!categories) continue;
      const cleanCats: Partial<Record<TaskCategory, ObservedCapability>> = {};
      for (const [cat, obs] of Object.entries(categories)) {
        if (isValidObserved(obs)) {
          cleanCats[cat as TaskCategory] = obs;
        }
      }
      clean[model] = cleanCats;
    }
    return clean;
  };

  const sanitizeObservedCapabilityByModelDifficulty = (overlay?: ObservedCapabilityByModelDifficulty): ObservedCapabilityByModelDifficulty | undefined => {
    if (!overlay) return undefined;
    const clean: ObservedCapabilityByModelDifficulty = {};
    for (const [model, categories] of Object.entries(overlay)) {
      if (!categories) continue;
      const cleanCats: Partial<Record<TaskCategory, Partial<Record<DifficultyBucket, ObservedCapability>>>> = {};
      for (const [cat, diffs] of Object.entries(categories)) {
        if (!diffs) continue;
        const cleanDiffs: Partial<Record<DifficultyBucket, ObservedCapability>> = {};
        for (const [diff, obs] of Object.entries(diffs)) {
          if (isValidObserved(obs)) {
            cleanDiffs[diff as DifficultyBucket] = obs;
          }
        }
        cleanCats[cat as TaskCategory] = cleanDiffs;
      }
      clean[model] = cleanCats;
    }
    return clean;
  };

  const cleanCtx: RouteContext = {
    ...baseCtx,
    observedCapability: sanitizeObservedCapability(baseCtx.observedCapability),
    observedCapabilityByModel: sanitizeObservedCapabilityByModel(baseCtx.observedCapabilityByModel),
    observedCapabilityByModelDifficulty: sanitizeObservedCapabilityByModelDifficulty(baseCtx.observedCapabilityByModelDifficulty),
  };

  const contributing = contributingOutcomes(events, now);

  function getFreshness(
    lane: Lane,
    category: TaskCategory,
    difficulty: DifficultyBucket | undefined,
    source: 'difficulty' | 'model' | 'lane' | undefined
  ): number | undefined {
    if (!source) return undefined;
    const modelKey = resolveLaneModelKey(lane);

    const laneOutcomes = contributing.filter((e) => {
      if (e.category !== category) return false;
      const outcomeModel = e.subject_model_resolved?.trim() || e.subject_model?.trim();

      if (source === 'difficulty') {
        return e.difficulty === difficulty && outcomeModel === modelKey;
      }
      if (source === 'model') {
        return outcomeModel === modelKey;
      }
      if (source === 'lane') {
        return e.subject_lane_id === lane.id;
      }
      return false;
    });

    const fresh = evidenceFreshnessDays(laneOutcomes, now);
    return fresh !== undefined && Number.isFinite(fresh) && fresh >= 0 ? fresh : undefined;
  }

  const differences: BacktestDifference[] = [];
  let diffCount = 0;

  // Sort workload cell keys to ensure deterministic output
  const sortedCellKeys = [...workloadCells.keys()].sort();

  for (const key of sortedCellKeys) {
    const cell = workloadCells.get(key)!;
    const task: Task = {
      category: cell.category,
      difficulty: cell.difficulty,
    };

    // Construct route context symmetrically for both policies
    const buildCtxForPolicy = (pol: BacktestPolicy): RouteContext => {
      return {
        ...cleanCtx,
        routingPolicy: pol,
        strategy: pol === 'cheapest' ? 'tiered' : undefined,
      };
    };

    const ctxA = buildCtxForPolicy(policyA);
    const ctxB = buildCtxForPolicy(policyB);

    let pickA = 'native';
    let pickB = 'native';

    try {
      pickA = routeDecide(task, ctxA, policy).laneId;
    } catch {
      // Fallback to native if routeDecide fails
    }

    try {
      pickB = routeDecide(task, ctxB, policy).laneId;
    } catch {
      // Fallback to native if routeDecide fails
    }

    if (pickA !== pickB) {
      diffCount += cell.count;

      const laneA = baseCtx.lanes.find((l) => l.id === pickA);
      const laneB = baseCtx.lanes.find((l) => l.id === pickB);

      let obsSourceA: 'difficulty' | 'model' | 'lane' | undefined;
      let obsSourceB: 'difficulty' | 'model' | 'lane' | undefined;

      let obsA = laneA
        ? observedForLaneWithDifficulty(
            laneA,
            cell.category,
            cell.difficulty,
            cleanCtx.observedCapability,
            cleanCtx.observedCapabilityByModel,
            cleanCtx.observedCapabilityByModelDifficulty,
            (src) => { obsSourceA = src; }
          )
        : undefined;

      let obsB = laneB
        ? observedForLaneWithDifficulty(
            laneB,
            cell.category,
            cell.difficulty,
            cleanCtx.observedCapability,
            cleanCtx.observedCapabilityByModel,
            cleanCtx.observedCapabilityByModelDifficulty,
            (src) => { obsSourceB = src; }
          )
        : undefined;

      // Sanitize observed cells
      if (!isValidObserved(obsA)) {
        obsA = undefined;
        obsSourceA = undefined;
      }
      if (!isValidObserved(obsB)) {
        obsB = undefined;
        obsSourceB = undefined;
      }

      const intA = obsA ? capabilityInterval(obsA) : undefined;
      const intB = obsB ? capabilityInterval(obsB) : undefined;

      const freshnessA = laneA ? getFreshness(laneA, cell.category, cell.difficulty, obsSourceA) : undefined;
      const freshnessB = laneB ? getFreshness(laneB, cell.category, cell.difficulty, obsSourceB) : undefined;

      const isThinA = !obsA || obsA.n < MIN_SIGNIFICANT_N;
      const isThinB = !obsB || obsB.n < MIN_SIGNIFICANT_N;

      let comparison: BacktestDifference['comparison'] = 'insufficient_evidence';
      if (isThinA || isThinB) {
        comparison = 'insufficient_evidence';
      } else if (intA && intB) {
        if (intA.lo > intB.hi) {
          comparison = 'favors_A';
        } else if (intB.lo > intA.hi) {
          comparison = 'favors_B';
        } else {
          comparison = 'neutral';
        }
      }

      const evidenceA = obsA ? sanitizeEvidence(obsA, intA?.lo, intA?.hi, freshnessA) : undefined;
      const evidenceB = obsB ? sanitizeEvidence(obsB, intB?.lo, intB?.hi, freshnessB) : undefined;

      const workloadSharePercent = totalDecisions > 0 ? (cell.count / totalDecisions) * 100 : 0;

      differences.push({
        category: cell.category,
        difficulty: cell.difficulty,
        workloadSharePercent,
        pickA,
        pickB,
        ...(evidenceA ? { evidenceA } : {}),
        ...(evidenceB ? { evidenceB } : {}),
        comparison,
      });
    }
  }

  // 3. Aggregate net signal weighted by evidence coverage
  let favorAVolume = 0;
  let favorBVolume = 0;
  let totalDiffVolume = 0;

  for (const diff of differences) {
    const cellKey = `${diff.category}:${diff.difficulty || ''}`;
    const cellCount = workloadCells.get(cellKey)?.count || 0;
    totalDiffVolume += cellCount;
    if (diff.comparison === 'favors_A') {
      favorAVolume += cellCount;
    } else if (diff.comparison === 'favors_B') {
      favorBVolume += cellCount;
    }
  }

  let netSignal: BacktestSummary['netSignal'] = 'neutral / insufficient';
  if (totalDiffVolume > 0) {
    const neutralOrInsufficientVolume = totalDiffVolume - favorAVolume - favorBVolume;
    // Coverage weight check: if most differing volume is insufficient/neutral, stay neutral/insufficient
    if (neutralOrInsufficientVolume < totalDiffVolume / 2) {
      if (favorAVolume > favorBVolume) {
        netSignal = 'evidence favors A';
      } else if (favorBVolume > favorAVolume) {
        netSignal = 'evidence favors B';
      }
    }
  }

  const diffPercent = totalDecisions > 0 ? (diffCount / totalDecisions) * 100 : 0;

  return {
    diffPercent,
    differences,
    netSignal,
  };
}
