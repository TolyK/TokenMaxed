/**
 * Vendor → Claude Code CLI plugin suggestions.
 *
 * Several vendors that TokenMaxed can reach via a BYOK **api** lane ALSO ship a
 * Claude Code CLI plugin that routes on the vendor's flat-rate SUBSCRIPTION
 * (treated as $0 metered, and fully trusted, like the codex lane). When a user
 * enables a BYOK api lane for one of these, the CLI plugin is almost always the
 * better choice — no key to manage (and no metered spend for a pay-per-token key)
 * — so setup nudges them toward it with a link.
 *
 * Pure + data-only (no I/O): a provenance lookup table, plus a helper that turns a
 * lane set into the suggestions to show. Only ENABLED, key-authenticated (BYOK) api
 * lanes trigger a nudge — a `blocked` template isn't "in use", and CLI/local lanes
 * never do (they already run on the subscription).
 */

import type { Lane } from '@tokenmaxed/core';

/** A Claude Code CLI plugin that can replace a vendor's metered BYOK api lane. */
export interface CliPlugin {
  /** Human-readable vendor name. */
  vendor: string;
  /** The CLI the plugin wraps (e.g. `grok`, `agy`, `codex`, `claude`). */
  cli: string;
  /** Plugin / install reference shown to the user. */
  plugin: string;
  /** Link to install / learn more. */
  url: string;
}

/**
 * Vendors with a known Claude Code CLI plugin, keyed by lane `provenance`. Only
 * vendors where a real CLI plugin exists are listed — so a lane whose provenance
 * is absent (zhipu, minimax, …) correctly produces NO suggestion (there is no CLI
 * alternative to point at).
 */
export const CLI_PLUGINS: Readonly<Record<string, CliPlugin>> = Object.freeze({
  openai: { vendor: 'OpenAI', cli: 'codex', plugin: 'codex', url: 'https://github.com/openai/codex' },
  xai: { vendor: 'xAI', cli: 'grok', plugin: 'grok-plugin-cc', url: 'https://github.com/TolyK/grok-plugin-cc' },
  google: {
    vendor: 'Google',
    cli: 'agy',
    plugin: 'antigravity-plugin-cc',
    url: 'https://github.com/TolyK/antigravity-plugin-cc',
  },
  anthropic: { vendor: 'Anthropic', cli: 'claude', plugin: 'Claude Code', url: 'https://claude.com/claude-code' },
});

/** The CLI plugin for a lane's provenance, if one exists. Case-insensitive on provenance. */
export function cliPluginForProvenance(provenance: string): CliPlugin | undefined {
  return CLI_PLUGINS[provenance.trim().toLowerCase()];
}

/** A nudge to replace an api/BYOK lane with a subscription CLI plugin. */
export interface PluginSuggestion {
  laneId: string;
  vendor: string;
  plugin: string;
  url: string;
}

/**
 * Suggestions for the given lane set: one per ENABLED (`trust_mode` ≠ `blocked`),
 * key-authenticated (`authHandle` set ⇒ BYOK) api lane whose vendor has a Claude
 * Code CLI plugin. CLI/local lanes are skipped (they already run on the
 * subscription); blocked api templates are skipped (not in use); an api lane with
 * no `authHandle` is skipped (not actually using a key). Deterministic config order.
 */
export function pluginSuggestionsFor(lanes: readonly Lane[]): PluginSuggestion[] {
  const out: PluginSuggestion[] = [];
  for (const lane of lanes) {
    if (lane.kind !== 'api' || lane.trust_mode === 'blocked' || !lane.authHandle) continue;
    const plugin = cliPluginForProvenance(lane.provenance);
    if (!plugin) continue;
    out.push({ laneId: lane.id, vendor: plugin.vendor, plugin: plugin.plugin, url: plugin.url });
  }
  return out;
}
