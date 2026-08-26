/**
 * Shared, runtime-light helpers for the Project "Atlas" tab.
 *
 * Everything here is design-token driven — node/edge colours resolve to CSS
 * variables (`var(--primary)` …) so they theme correctly in light AND dark and
 * never hardcode a hex value (see CLAUDE.md "Design system").
 */
import type { AnalysisStatus } from "@repo/atlas/types";

/**
 * A small, stable palette for languages, all sourced from semantic tokens so
 * the graph stays on-brand and theme-aware. Unknown languages fall back to the
 * neutral foreground token.
 */
export function languageColorVar(language: string | null): string {
	if (!language) {
		return "var(--muted-foreground)";
	}
	const normalized = language.toLowerCase();
	switch (normalized) {
		case "typescript":
		case "tsx":
		case "javascript":
		case "jsx":
			return "var(--primary)";
		case "python":
		case "py":
			return "var(--secondary)";
		case "go":
		case "rust":
		case "java":
		case "kotlin":
		case "csharp":
		case "c#":
			return "var(--highlight)";
		default:
			return "var(--muted-foreground)";
	}
}

/**
 * Lightweight fuzzy matcher (no dependency). Returns a score (higher = better)
 * when every character of `query` appears in `target` in order as a subsequence,
 * or `null` when there's no match. Rewards consecutive runs and matches at word
 * boundaries (after `/ . _ -` or a space) and lightly penalises longer targets —
 * enough to rank graph nodes by relevance without pulling in a search library.
 */
export function fuzzyScore(query: string, target: string): number | null {
	const q = query.trim().toLowerCase();
	if (!q) {
		return 0;
	}
	const t = target.toLowerCase();
	let score = 0;
	let qi = 0;
	let prevMatch = -2;
	let run = 0;
	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] !== q[qi]) {
			continue;
		}
		let charScore = 1;
		// Consecutive-character runs are a strong signal of a good match.
		if (prevMatch === ti - 1) {
			run += 1;
			charScore += run * 4;
		} else {
			run = 0;
		}
		// Word-boundary starts ("auth" in "src/auth.ts") score higher.
		const prev = ti > 0 ? t[ti - 1] : "";
		if (
			ti === 0 ||
			prev === "/" ||
			prev === "." ||
			prev === "_" ||
			prev === "-" ||
			prev === " "
		) {
			charScore += 8;
		}
		score += charScore;
		prevMatch = ti;
		qi += 1;
	}
	// Every query character must have been consumed for a valid match.
	if (qi < q.length) {
		return null;
	}
	// Prefer denser matches in shorter targets.
	return score - t.length * 0.05;
}

/**
 * Compact relative-time formatter ("just now", "3m ago", "2d ago", or a date).
 * Mirrors the convention used elsewhere in the project tabs (DiagramsList).
 */
export function formatRelativeTime(iso: string | null): string {
	if (!iso) {
		return "";
	}
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) {
		return "";
	}
	const diff = Date.now() - then;
	if (diff < 60_000) {
		return "just now";
	}
	if (diff < 3_600_000) {
		return `${Math.floor(diff / 60_000)}m ago`;
	}
	if (diff < 86_400_000) {
		return `${Math.floor(diff / 3_600_000)}h ago`;
	}
	if (diff < 2_592_000_000) {
		return `${Math.floor(diff / 86_400_000)}d ago`;
	}
	return new Date(iso).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

/**
 * Recency buckets for the conversation-history view, oldest-open-last. The chat
 * history groups conversations into Today / Yesterday / This week / Older so a
 * long list reads as a scannable timeline instead of one undifferentiated wall.
 */
export type RecencyBucket = "today" | "yesterday" | "thisWeek" | "older";

/**
 * Classify an ISO timestamp into a recency bucket relative to `now` (local
 * midnight boundaries):
 *   - today      — on or after the start of today
 *   - yesterday  — the calendar day before today
 *   - thisWeek   — 2–6 days ago (the rest of the trailing 7-day window)
 *   - older      — 7+ days ago, or an unpar'seable timestamp
 */
export function recencyBucketOf(
	iso: string,
	now: number = Date.now(),
): RecencyBucket {
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) {
		return "older";
	}
	const startOfToday = new Date(now);
	startOfToday.setHours(0, 0, 0, 0);
	const todayMs = startOfToday.getTime();
	const dayMs = 86_400_000;
	if (then >= todayMs) {
		return "today";
	}
	if (then >= todayMs - dayMs) {
		return "yesterday";
	}
	if (then >= todayMs - 6 * dayMs) {
		return "thisWeek";
	}
	return "older";
}

/**
 * Group items into the four recency buckets, preserving each item's position
 * (the caller passes a newest-first list, so each bucket stays newest-first).
 */
export function bucketByRecency<T>(
	items: readonly T[],
	getIso: (item: T) => string,
	now: number = Date.now(),
): Record<RecencyBucket, T[]> {
	const buckets: Record<RecencyBucket, T[]> = {
		today: [],
		yesterday: [],
		thisWeek: [],
		older: [],
	};
	for (const item of items) {
		buckets[recencyBucketOf(getIso(item), now)].push(item);
	}
	return buckets;
}

/** True while the backend analysis is actively running (drives polling). */
export function isAnalysisInFlight(
	status: AnalysisStatus | undefined,
): boolean {
	return status === "ANALYZING" || status === "PENDING";
}

/**
 * Human-friendly elapsed-time formatter for analysis-run durations.
 *
 * The largest fitting unit wins so a long run never reads as a giant seconds
 * count (e.g. a 65-minute run is "1h 5m", not "3900s"):
 *   - ≥ 1h  → "{h}h {m}m"   e.g. "1h 5m"
 *   - ≥ 1m  → "{m}m {s}s"   e.g. "1m 23s"
 *   - ≥ 10s → "{s}s"        whole seconds, e.g. "42s"
 *   - < 10s → "{s.s}s"      one decimal, e.g. "8.3s"
 *
 * Rounding carries cleanly between units (no "1m 60s" / "1h 60m"). Returns ""
 * for null / NaN / negative input. Unit letters (h/m/s) are locale-agnostic, so
 * this is intentionally i18n-free (see the Atlas history panel).
 */
export function formatDuration(ms: number | null): string {
	if (ms === null || Number.isNaN(ms) || ms < 0) {
		return "";
	}
	if (ms >= 3_600_000) {
		const totalMinutes = Math.round(ms / 60_000);
		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;
		return `${hours}h ${minutes}m`;
	}
	if (ms >= 60_000) {
		const totalSeconds = Math.round(ms / 1000);
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${minutes}m ${seconds}s`;
	}
	if (ms >= 10_000) {
		return `${Math.round(ms / 1000)}s`;
	}
	return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Compact token-count formatter for the analysis-history telemetry line —
 * mirrors the "12.5k" / "1.2M" convention used across the dashboards:
 *   - < 1,000      → the integer        e.g. "950"
 *   - < 1,000,000  → "{n.n}k"           e.g. "12.5k" (a trailing ".0" is trimmed → "1k")
 *   - ≥ 1,000,000  → "{n.n}M"           e.g. "1.2M"
 *
 * Returns "" for null / NaN / negative input so the row can omit the field.
 */
export function formatTokens(tokens: number | null): string {
	if (tokens === null || Number.isNaN(tokens) || tokens < 0) {
		return "";
	}
	if (tokens < 1000) {
		return String(Math.round(tokens));
	}
	const trimZero = (value: string) => value.replace(/\.0$/, "");
	if (tokens < 1_000_000) {
		return `${trimZero((tokens / 1000).toFixed(1))}k`;
	}
	return `${trimZero((tokens / 1_000_000).toFixed(1))}M`;
}

/**
 * Format a micro-USD cost (value / 1e6 = USD) as a compact dollar string for
 * the analysis-history telemetry line:
 *   - 0       → "$0"
 *   - < $1    → 4 decimals ("$0.0023") so sub-cent runs stay legible; a value
 *               that rounds to "$0.0000" shows a "<$0.0001" floor so a real
 *               (tiny) cost is never displayed as free
 *   - ≥ $1    → 2 decimals ("$1.23")
 *
 * Returns "" for null / NaN / negative input so the row can omit the field.
 */
export function formatUsdFromMicros(micros: number | null): string {
	if (micros === null || Number.isNaN(micros) || micros < 0) {
		return "";
	}
	const usd = micros / 1_000_000;
	if (usd === 0) {
		return "$0";
	}
	if (usd < 1) {
		const fixed = usd.toFixed(4);
		return fixed === "0.0000" ? "<$0.0001" : `$${fixed}`;
	}
	return `$${usd.toFixed(2)}`;
}
