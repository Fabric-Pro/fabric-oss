/**
 * Schema, content-mapping, and Markdown-assembly helpers for the security /
 * accessibility finding-grouping ticket-drafting call (spec §6 of the
 * 2026-07-01-security-finding-tickets spec).
 *
 * Mirrors `review-schemas.ts` / `scan-schemas.ts`'s established "permissive
 * schema, normalize in code" pattern (ADR-007): the model-facing
 * `TicketDraftSchema` is intentionally LENIENT (plain optional strings, no
 * `z.enum` / `z.preprocess` — a strict/preprocessed node produces an untyped
 * JSON-schema node the AI gateway rejects outright), and every field is
 * normalized/defaulted in `mapRawTicketDraftToContent`, never in the schema.
 *
 * This file holds only pure, dependency-free mapping/formatting helpers — the
 * actual `generateObject` call (model resolution + prompt) lives in
 * `grouping-activities.ts`, mirroring the `review-schemas.ts` /
 * `review-activities.ts` split.
 *
 * Security note: every quoted finding field (title/description/location) is
 * already guaranteed secret-redacted at scan-persist time by `redactSecrets`
 * (see `scan-schemas.ts`'s `mapRawFindingToDraft`, which runs every persisted
 * field through it before a `ScanFinding` row is ever written). The
 * AI-authored narrative synthesized here (`summary`/`remediation`) is
 * generated FROM that already-redacted text, so it cannot reintroduce a
 * secret absent from its source — no additional redaction pass is added in
 * this file.
 */

import type { StoryPriority } from "@repo/database";
import { z } from "zod";
import type { ScanSeverityValue } from "./scan-schemas";

export type { ScanSeverityValue } from "./scan-schemas";

/** The two theme categories a finding can belong to. */
export type GroupingCategory = "SECURITY" | "ACCESSIBILITY";

/**
 * The minimal finding shape the ticket-assembly helpers below need.
 * Deliberately narrower than a full `ScanFinding` row — a real `ScanFinding`
 * satisfies this structurally, since only these fields are read here.
 */
export interface GroupingFindingInput {
	title: string;
	severity: ScanSeverityValue;
	description: string;
	location: string | null;
	/** [0,1] reviewer confidence; null/omitted -> no "Confidence: " suffix. */
	confidence?: number | null;
}

// =============================================================================
// Lenient drafting-call output schema
// =============================================================================

/**
 * What the drafting call returns for one theme. Every field is an optional
 * plain string (lenient — see file header): no `z.enum`, no `z.preprocess`.
 * Missing fields fall back to deterministic text in
 * `mapRawTicketDraftToContent`.
 */
export const TicketDraftSchema = z.object({
	title: z
		.string()
		.optional()
		.describe(
			"A short, specific title (no category prefix — that's added separately) summarizing this theme, e.g. 'Exposed credentials in Git history — 5 secrets across 3 files'.",
		),
	summary: z
		.string()
		.optional()
		.describe(
			"2-4 sentence paragraph explaining what this group of findings represents and why it matters.",
		),
	remediation: z
		.string()
		.optional()
		.describe(
			"Aggregated, actionable remediation guidance synthesized across all member findings — concrete steps, not generic advice.",
		),
});

export type RawTicketDraft = z.infer<typeof TicketDraftSchema>;

/** Normalized, always-populated ticket content ready for title/body assembly. */
export interface TicketDraftContent {
	title: string;
	summary: string;
	remediation: string;
}

/** The theme-level facts `mapRawTicketDraftToContent`'s fallbacks need. */
export interface TicketDraftThemeContext {
	category: GroupingCategory;
	ruleSource: string;
	findingCount: number;
}

const CATEGORY_LABEL: Record<GroupingCategory, "Security" | "Accessibility"> = {
	SECURITY: "Security",
	ACCESSIBILITY: "Accessibility",
};

/** `"SECURITY"` -> `"Security"`, `"ACCESSIBILITY"` -> `"Accessibility"` — the ticket title's category prefix (§6). */
export function categoryLabel(
	category: GroupingCategory,
): "Security" | "Accessibility" {
	return CATEGORY_LABEL[category];
}

/**
 * Normalize the raw drafting-call output into always-populated ticket
 * content:
 * - Missing/blank `title` falls back to `theme.ruleSource` VERBATIM (mirrors
 *   `scan-schemas.ts`'s `deriveTitle` fallback philosophy).
 * - Missing/blank `summary` / `remediation` fall back to a deterministic
 *   one-line sentence, so a `processThemeActivity` retry exhaustion (the
 *   drafting call fails outright) still produces a usable ticket instead of
 *   an empty section.
 */
export function mapRawTicketDraftToContent(
	raw: RawTicketDraft,
	theme: TicketDraftThemeContext,
): TicketDraftContent {
	const title = raw.title?.trim() || theme.ruleSource;
	const summary =
		raw.summary?.trim() ||
		`This ticket groups ${theme.findingCount} ${categoryLabel(theme.category).toLowerCase()} finding(s) reported under "${theme.ruleSource}".`;
	const remediation =
		raw.remediation?.trim() ||
		"Review each finding listed below and apply the remediation guidance specific to it.";
	return { title, summary, remediation };
}

// =============================================================================
// Severity -> priority (D5)
// =============================================================================

const SEVERITY_TO_PRIORITY: Record<ScanSeverityValue, StoryPriority> = {
	CRITICAL: "P0_CRITICAL",
	HIGH: "P1_HIGH",
	MEDIUM: "P2_MEDIUM",
	LOW: "P3_LOW",
};

/** Worst-first rank (CRITICAL=0 ... LOW=3) — mirrors the frontend's `SEVERITY_RANK`. */
const SEVERITY_RANK: Record<ScanSeverityValue, number> = {
	CRITICAL: 0,
	HIGH: 1,
	MEDIUM: 2,
	LOW: 3,
};

/**
 * Theme priority = the highest (worst) severity among its findings (D5),
 * mapped 1:1 onto `StoryPriority`: CRITICAL->P0_CRITICAL, HIGH->P1_HIGH,
 * MEDIUM->P2_MEDIUM, LOW->P3_LOW. A mixed-severity theme (e.g. one CRITICAL +
 * one LOW finding) takes the CRITICAL-derived priority — the description's
 * severity breakdown (`assembleTicketBody`) still shows every count, not just
 * the max. Defaults to the lowest priority for an empty findings array
 * (never happens for a real theme; mirrors the frontend's `worstSeverity`
 * empty-set default).
 */
export function maxSeverityToPriority(
	findings: ReadonlyArray<Pick<GroupingFindingInput, "severity">>,
): StoryPriority {
	let worst: ScanSeverityValue = "LOW";
	for (const finding of findings) {
		if (SEVERITY_RANK[finding.severity] < SEVERITY_RANK[worst]) {
			worst = finding.severity;
		}
	}
	return SEVERITY_TO_PRIORITY[worst];
}

// =============================================================================
// Scanner attribution — ported from the frontend (PR #1658), not re-derived
// =============================================================================

/**
 * Which scanner engine produced a finding. Ported (not imported —
 * `packages/temporal` cannot depend on `apps/web`) from
 * `apps/web/modules/saas/projects/components/security/lib.ts`'s
 * `getFindingScanner` (PR #1658), which already backs the findings list's
 * scanner chip. Keep the prefixes/labels below in sync with that file if they
 * ever change.
 */
export type FindingScannerAttribution =
	| "AI_SECURITY"
	| "AI_ACCESSIBILITY"
	| "SEMGREP"
	| "GIT_HISTORY";

/** Prefixes the scan workflow stamps onto a finding's `ruleSource` per engine. */
const SEMGREP_RULE_PREFIX = "Semgrep:";
const GIT_HISTORY_RULE_PREFIX = "Secret history:";

const FINDING_SCANNER_LABEL: Record<FindingScannerAttribution, string> = {
	AI_SECURITY: "AI review",
	AI_ACCESSIBILITY: "AI review",
	SEMGREP: "Semgrep",
	GIT_HISTORY: "Git history",
};

/**
 * Derive the engine that captured a finding from its `ruleSource` +
 * `category` — a ported twin of the frontend's `getFindingScanner`. All
 * findings within one theme share the same `(category, ruleSource)` (that's
 * the theme's grouping key), so this only needs to run once per theme.
 */
export function deriveFindingScanner(
	ruleSource: string,
	category: GroupingCategory,
): FindingScannerAttribution {
	if (ruleSource.startsWith(SEMGREP_RULE_PREFIX)) {
		return "SEMGREP";
	}
	if (ruleSource.startsWith(GIT_HISTORY_RULE_PREFIX)) {
		return "GIT_HISTORY";
	}
	return category === "ACCESSIBILITY" ? "AI_ACCESSIBILITY" : "AI_SECURITY";
}

/** Human-readable "Detected by: " label for the ticket body's Source section. */
export function describeFindingScanner(
	ruleSource: string,
	category: GroupingCategory,
): string {
	return FINDING_SCANNER_LABEL[deriveFindingScanner(ruleSource, category)];
}

// =============================================================================
// Ticket body assembly (§6)
// =============================================================================

const SEVERITY_DISPLAY_ORDER: readonly ScanSeverityValue[] = [
	"CRITICAL",
	"HIGH",
	"MEDIUM",
	"LOW",
];

const SEVERITY_DISPLAY_LABEL: Record<ScanSeverityValue, string> = {
	CRITICAL: "Critical",
	HIGH: "High",
	MEDIUM: "Medium",
	LOW: "Low",
};

/**
 * One line showing EVERY per-severity count (not just the theme's max) — a
 * mixed CRITICAL+LOW theme must still show both counts even though its
 * priority is derived from CRITICAL alone.
 */
function buildSeverityBreakdownLine(
	findings: readonly GroupingFindingInput[],
): string {
	const counts: Record<ScanSeverityValue, number> = {
		CRITICAL: 0,
		HIGH: 0,
		MEDIUM: 0,
		LOW: 0,
	};
	for (const finding of findings) {
		counts[finding.severity] += 1;
	}
	return SEVERITY_DISPLAY_ORDER.map(
		(severity) =>
			`- ${SEVERITY_DISPLAY_LABEL[severity]}: ${counts[severity]}`,
	).join("   ");
}

/**
 * Render one finding as a numbered Markdown list item: title, severity, an
 * optional confidence suffix, location, description. Shared by the initial
 * ticket's "Findings" section (`buildFindingsSection`) and the incremental
 * AGENT comment (`buildNewFindingsSummary`) so a finding renders identically
 * whether it's shown in the original ticket body or a later rerun's comment.
 */
function formatFindingListItem(
	finding: GroupingFindingInput,
	index: number,
): string {
	const confidenceSuffix =
		finding.confidence === null || finding.confidence === undefined
			? ""
			: `, Confidence: ${finding.confidence.toFixed(2)}`;
	const location = finding.location ?? "Not specified";
	return `${index + 1}. **${finding.title}** — ${SEVERITY_DISPLAY_LABEL[finding.severity]}${confidenceSuffix}\n   - Location: ${location}\n   - ${finding.description}`;
}

function buildFindingsSection(
	findings: readonly GroupingFindingInput[],
): string {
	const header = `## Findings (${findings.length})`;
	if (findings.length === 0) {
		return header;
	}
	const items = findings
		.map((finding, index) => formatFindingListItem(finding, index))
		.join("\n\n");
	return `${header}\n${items}`;
}

/**
 * Render the incremental `AGENT`-authored comment body posted when a theme
 * that already has a ticket picks up new findings on a rerun (D11 — the
 * ticket description itself is never edited after creation; this comment is
 * the sole mechanism for surfacing new findings). Reuses
 * `formatFindingListItem` so a finding looks identical whether it appears in
 * the original ticket body or a later incremental comment.
 */
export function buildNewFindingsSummary(
	findings: readonly GroupingFindingInput[],
): string {
	const count = findings.length;
	const header = `Found ${count} new finding${count === 1 ? "" : "s"} for this theme since the last run:`;
	const items = findings
		.map((finding, index) => formatFindingListItem(finding, index))
		.join("\n\n");
	return `${header}\n\n${items}`;
}

function formatScanCompletedAt(scanCompletedAt: Date | string | null): string {
	if (!scanCompletedAt) {
		return "Unknown";
	}
	return scanCompletedAt instanceof Date
		? scanCompletedAt.toISOString()
		: scanCompletedAt;
}

export interface AssembleTicketBodyInput {
	category: GroupingCategory;
	ruleSource: string;
	findings: readonly GroupingFindingInput[];
	/** Already-normalized content — pass `mapRawTicketDraftToContent`'s output. */
	draft: TicketDraftContent;
	scanCompletedAt: Date | string | null;
}

/**
 * Deterministic Markdown ticket description (§6): Summary, full severity
 * breakdown, numbered findings list, suggested remediation, and source
 * attribution — in that order, each section separated by a blank line.
 */
export function assembleTicketBody(input: AssembleTicketBodyInput): string {
	const { category, ruleSource, findings, draft, scanCompletedAt } = input;
	const sections = [
		`## Summary\n${draft.summary}`,
		`## Severity breakdown\n${buildSeverityBreakdownLine(findings)}`,
		buildFindingsSection(findings),
		`## Suggested remediation\n${draft.remediation}`,
		`## Source\nDetected by: ${describeFindingScanner(ruleSource, category)}\nScan: completed ${formatScanCompletedAt(scanCompletedAt)}`,
	];
	return sections.join("\n\n");
}

export interface DeterministicTailInput {
	category: GroupingCategory;
	ruleSource: string;
	findings: readonly GroupingFindingInput[];
	scanCompletedAt: Date | string | null;
}

/**
 * The deterministic, code-owned tail appended AFTER the AI narrative in the
 * preview/apply flow: the full per-severity breakdown, the exhaustive numbered
 * findings list (every finding — never a sample), and the scan source. This is
 * what guarantees "100% of findings represented" regardless of what the
 * `security_finding_ticket` prompt writes; the prompt is told the system
 * appends this, so it never re-lists findings. Order + formatting mirror
 * `assembleTicketBody`'s tail so a ticket reads identically either way.
 */
export function buildDeterministicTail(input: DeterministicTailInput): string {
	const { category, ruleSource, findings, scanCompletedAt } = input;
	return [
		`## Severity breakdown\n${buildSeverityBreakdownLine(findings)}`,
		buildFindingsSection(findings),
		`## Source\nDetected by: ${describeFindingScanner(ruleSource, category)}\nScan: completed ${formatScanCompletedAt(scanCompletedAt)}`,
	].join("\n\n");
}
