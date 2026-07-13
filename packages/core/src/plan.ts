/**
 * Pure plan optimizer advisory logic (read-only).
 *
 * Grounded strictly in ledger evidence, this module analyzes routed history
 * and provides recommendations on lane subscriptions without fabricating plan costs.
 */

import type { Lane, TaskCategory, RouteContext } from './types.ts';
import { declaredCapabilityFor, effectiveCapabilityFor } from './route.ts';
import { priceForModel } from './price.ts';
import type { PriceTable } from './price.ts';
import { summarize } from './ledger.ts';
import type { LedgerEvent } from './ledger.ts';

export interface LanePlanStats {
  laneId: string;
  deliveredCount: number;
  routedCount: number;
  share: number; // percentage (0-100) of total routed offloads
  sharePercentageOfRoutedAttempts: number; // explicit scope metadata (FIX 4b)
  shareScope: string; // explicit scope metadata (FIX 4b)
  meteredSpent: number | null; // null/omitted when unavailable (FIX 1)
  meteredSpentUnavailable?: boolean;
  categoryDistribution: Partial<Record<TaskCategory, number>>;
  categoryDistributionRoutedAttempts: Partial<Record<TaskCategory, number>>; // explicit scope metadata (FIX 4b)
  categoryDistributionScope: string; // explicit scope metadata (FIX 4b)
}

export interface PlanOptimizationSuggestion {
  title: string;
  evidence: string;
  suggestion: string;
}

export interface PlanOptimizationResult {
  totalRoutedOffloads: number;
  laneStats: Record<string, LanePlanStats>;
  frontierCategoryBreakdown: Record<string, Partial<Record<TaskCategory, number>>>;
  frontierCategoryBreakdownRoutedAttempts: Record<string, Partial<Record<TaskCategory, number>>>; // explicit scope (FIX 4b)
  frontierCategoryBreakdownScope: string; // explicit scope (FIX 4b)
  suggestions: PlanOptimizationSuggestion[];
  message?: string;
}

/** Helper to check if lane Y is cheaper than lane X for a given category. */
export function isLaneCheaperForCategory(
  y: Lane,
  x: Lane,
  category: TaskCategory,
  nonNativeTasks: readonly Extract<LedgerEvent, { event_type: 'task' }>[],
  priceTable: PriceTable
): boolean {
  const basisRank = { local: 0, subscription: 0, metered: 1 };
  const rankY = basisRank[y.costBasis] ?? 99;
  const rankX = basisRank[x.costBasis] ?? 99;

  if (rankY !== rankX) {
    return rankY < rankX;
  }

  // If both are metered, compare based on the observed token mix for this category
  if (y.costBasis === 'metered' && x.costBasis === 'metered') {
    const categoryTasks = nonNativeTasks.filter((e) => e.category === category);
    if (categoryTasks.length === 0) {
      return false; // Cannot substantiate without evidence
    }

    const avgIn = categoryTasks.reduce((sum, e) => sum + e.tokens_in, 0) / categoryTasks.length;
    const avgOut = categoryTasks.reduce((sum, e) => sum + e.tokens_out, 0) / categoryTasks.length;
    const avgUsage = { tokens_in: avgIn, tokens_out: avgOut };

    try {
      const priceY = priceForModel(priceTable, y.model, avgUsage);
      const priceX = priceForModel(priceTable, x.model, avgUsage);
      return priceY < priceX;
    } catch {
      return false;
    }
  }

  // Both local and subscription are non-metered (rank 0). Neither is cheaper.
  return false;
}

/** Pure analyzer that turns routing history into suggestions. */
export function analyzePlan(
  events: readonly LedgerEvent[],
  lanes: readonly Lane[],
  priceTable: PriceTable,
  now: number,
  opts: {
    periodLabel?: string;
    routingContext?: RouteContext;
  } = {}
): PlanOptimizationResult {
  const periodLabel = opts.periodLabel ?? 'all history';

  // Compose with canonical summarize
  const summary = summarize(events);
  const totalRoutedOffloads = summary.events;

  // Empty/sparse ledger check
  if (totalRoutedOffloads < 5) {
    return {
      totalRoutedOffloads,
      laneStats: {},
      frontierCategoryBreakdown: {},
      frontierCategoryBreakdownRoutedAttempts: {},
      frontierCategoryBreakdownScope: 'routed attempts per frontier lane',
      suggestions: [],
      message: 'not enough routed history to advise yet (need more offloads)',
    };
  }

  // Build the set of all lanes (including historical ones seen in the ledger)
  const taskEvents = events.filter((e): e is Extract<LedgerEvent, { event_type: 'task' }> & { category: TaskCategory } => e.event_type === 'task');
  const nonNativeTasks = taskEvents.filter((e) => e.status !== 'native');

  const seenLanes = new Set(lanes.map((l) => l.id));
  const allLanesList = [...lanes];

  for (const e of nonNativeTasks) {
    if (!seenLanes.has(e.laneId)) {
      seenLanes.add(e.laneId);
      allLanesList.push({
        id: e.laneId,
        kind: 'api',
        model: e.model,
        trust_mode: e.trust_mode,
        costBasis: e.actual_cost > 0 || e.metered_spent > 0 ? 'metered' : 'subscription',
        provenance: e.provenance,
        jurisdiction: 'US',
        capability: {},
      });
    }
  }

  // Initialize stats per lane
  const laneStats: Record<string, LanePlanStats> = {};
  for (const lane of allLanesList) {
    if (lane.native) continue;
    laneStats[lane.id] = {
      laneId: lane.id,
      deliveredCount: 0,
      routedCount: 0,
      share: 0,
      sharePercentageOfRoutedAttempts: 0,
      shareScope: 'routed-share only',
      meteredSpent: 0,
      categoryDistribution: {},
      categoryDistributionRoutedAttempts: {},
      categoryDistributionScope: 'routed attempts',
    };
  }

  // Accumulate counts safely
  for (const e of nonNativeTasks) {
    const stats = laneStats[e.laneId];
    if (!stats) continue;

    stats.routedCount += 1;
    // Align delivered with summarize() semantics: status === 'ok' and not superseded
    if (e.status === 'ok' && e.superseded !== true) {
      stats.deliveredCount += 1;
    }

    if (stats.meteredSpentUnavailable !== true) {
      if (!Number.isFinite(e.metered_spent) || e.metered_spent < 0) {
        stats.meteredSpentUnavailable = true;
        stats.meteredSpent = null;
      } else {
        if (stats.meteredSpent === null) {
          stats.meteredSpent = e.metered_spent;
        } else {
          stats.meteredSpent += e.metered_spent;
        }
      }
    }

    stats.categoryDistribution[e.category] = (stats.categoryDistribution[e.category] ?? 0) + 1;
    stats.categoryDistributionRoutedAttempts[e.category] = (stats.categoryDistributionRoutedAttempts[e.category] ?? 0) + 1;
  }

  // Compute shares based on routed attempts, and final check on metered spent
  for (const laneId of Object.keys(laneStats)) {
    const stats = laneStats[laneId]!;
    stats.share = totalRoutedOffloads > 0 ? (100 * stats.routedCount) / totalRoutedOffloads : 0;
    if (!Number.isFinite(stats.share) || stats.share < 0) {
      stats.share = 0;
    }
    stats.sharePercentageOfRoutedAttempts = stats.share;

    if (!stats.meteredSpentUnavailable) {
      if (stats.meteredSpent !== null && (!Number.isFinite(stats.meteredSpent) || stats.meteredSpent < 0)) {
        stats.meteredSpentUnavailable = true;
        stats.meteredSpent = null;
      }
    }
  }

  // Find frontier model and lanes
  const frontierModel = priceTable.frontier_model;
  // Recommendations are active-lanes-only (FIX 6)
  const frontierLanes = lanes.filter((l) => l.model === frontierModel);
  const frontierLaneIds = new Set(frontierLanes.map((l) => l.id));

  // Compute category breakdown per frontier lane
  const frontierCategoryBreakdown: Record<string, Partial<Record<TaskCategory, number>>> = {};
  const frontierCategoryBreakdownRoutedAttempts: Record<string, Partial<Record<TaskCategory, number>>> = {};
  for (const fLane of frontierLanes) {
    frontierCategoryBreakdown[fLane.id] = {};
    frontierCategoryBreakdownRoutedAttempts[fLane.id] = {};
  }

  for (const e of nonNativeTasks) {
    if (frontierLaneIds.has(e.laneId)) {
      const breakdown = frontierCategoryBreakdown[e.laneId];
      const breakdownRouted = frontierCategoryBreakdownRoutedAttempts[e.laneId];
      if (breakdown && breakdownRouted) {
        breakdown[e.category] = (breakdown[e.category] ?? 0) + 1;
        breakdownRouted[e.category] = (breakdownRouted[e.category] ?? 0) + 1;
      }
    }
  }

  const suggestions: PlanOptimizationSuggestion[] = [];

  // 1. Underused lane suggestion (neutral economics, active lanes only)
  for (const lane of lanes) {
    if (lane.native) continue;
    const stats = laneStats[lane.id];
    if (!stats) continue;

    // Check if share of routed attempts is low (e.g. < 10%)
    if (stats.share < 10) {
      const shareStr = stats.share.toFixed(1);
      suggestions.push({
        title: `Underused lane: ${lane.id}`,
        evidence: `lane ${lane.id} handled ${stats.routedCount} of your ${totalRoutedOffloads} routed attempts (${shareStr}% routed-share) (routed-share only — not your total usage) over ${periodLabel}`,
        suggestion: `Consider reviewing the configuration and usage of lane ${lane.id}, as it has a low routed usage share.`,
      });
    }
  }

  // 2. Frontier-conservation suggestion (per-frontier-lane FL attribution, active lanes only)
  for (const FL of frontierLanes) {
    const stats = laneStats[FL.id];
    if (!stats || stats.routedCount === 0) continue;

    const breakdown = frontierCategoryBreakdown[FL.id] ?? {};
    const categories = Object.keys(breakdown) as TaskCategory[];

    for (const cat of categories) {
      const count = breakdown[cat] ?? 0;
      const share = (100 * count) / stats.routedCount;

      if (share >= 20) {
        // Find a cheaper capable lane Y
        for (const Y of lanes) {
          if (Y.native || Y.id === FL.id || Y.model === frontierModel) continue;
          if (isLaneCheaperForCategory(Y, FL, cat, nonNativeTasks, priceTable)) {
            // Compute Y's capability
            const capY = opts.routingContext
              ? effectiveCapabilityFor(Y, cat, opts.routingContext.observedCapability, {
                  modelOverlay: opts.routingContext.observedCapabilityByModel,
                  difficultyOverlay: opts.routingContext.observedCapabilityByModelDifficulty,
                })
              : declaredCapabilityFor(Y, cat);

            if (capY >= 0.70) {
              const shareStr = share.toFixed(1);
              suggestions.push({
                title: `Frontier-conservation: ${FL.id} (${cat})`,
                evidence: `category "${cat}" constitutes ${shareStr}% of your frontier lane ${FL.id}'s routed attempts (${count} of ${stats.routedCount} routed attempts) (routed-share only — not your total usage) over ${periodLabel}, and lane ${Y.id} is capable (capability ${capY.toFixed(2)}) and cheaper (${Y.costBasis} vs ${FL.costBasis})`,
                suggestion: `routing category ${cat} to ${Y.id} would ease pressure on ${FL.id}`,
              });
            }
          }
        }
      }
    }
  }

  // 3. Metered spend suggestion (neutral/factual, active lanes only, handles overflow)
  for (const lane of lanes) {
    if (lane.native) continue;
    const stats = laneStats[lane.id];
    if (!stats) continue;

    const hasSpent = (stats.meteredSpent !== null && stats.meteredSpent > 0) || stats.meteredSpentUnavailable;
    if (lane.costBasis === 'metered' && hasSpent) {
      const spendStr = stats.meteredSpentUnavailable
        ? 'metered spend unavailable — data anomaly'
        : `$${(stats.meteredSpent ?? 0).toFixed(4)}`;

      suggestions.push({
        title: `Metered spend: ${lane.id}`,
        evidence: `you spent ${spendStr} metered on lane ${lane.id} (routed-share only — not your total usage) across ${stats.routedCount} routed attempts over ${periodLabel}`,
        suggestion: `Consider routing these tasks to a subscription or local lane as an alternative to avoid metered charges.`,
      });
    }
  }

  return {
    totalRoutedOffloads,
    laneStats,
    frontierCategoryBreakdown,
    frontierCategoryBreakdownRoutedAttempts,
    frontierCategoryBreakdownScope: 'routed attempts per frontier lane',
    suggestions,
  };
}
