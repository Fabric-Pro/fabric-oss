/**
 * Shared types, constants, and helpers for the Security & Accessibility
 * scanning UI. Severity / status / category vocabularies mirror the oRPC
 * contracts under `orpc.projects.scan.*`. All colors map to design tokens via
 * Badge variants — no hardcoded hex.
 */
import type { orpcClient } from "@shared/lib/orpc-client";
import type { BadgeProps } from "@ui/components/badge";
import {
	CheckIcon,
	ClockIcon,
	Loader2Icon,
	type LucideIcon,
	MinusIcon,
} from "lucide-react";

/**
 * Server-inferred shapes — single source of truth, so the UI never drifts from
 * the oRPC contract. Use these for data flowing between components.
 */
export type ResolvedScanConfig = Awaited<
	ReturnType<typeof orpcClient.projects.scan.config.get>
>["config"];

export type ProjectScan = NonNullable<
	Awaited<ReturnType<typeof orpcClient.projects.scan.latest>>["scan"]
>;

export type ScanFinding = Awaited<
	ReturnType<typeof orpcClient.projects.scan.findings.list>
>["findings"][number];

export type ScanActivity = Awaited<
	ReturnType<typeof orpcClient.projects.scan.activity>
>["activity"][number];

/**
 * One branch's incremental-scan status row from `scan.branches` — server-inferred
 * so the branch-coverage panel never drifts from the API contract.
 */
export type BranchScanStatus = Awaited<
	ReturnType<typeof orpcClient.projects.scan.branches>
>["branches"][number];

/** The four states a branch can be in (SCANNED / STALE / NOT_SCANNED / SCANNING). */
export type BranchScanStatusValue = BranchScanStatus["status"];

/**
 * The on-demand false-positive review (G7) — server-inferred so the dialog
 * never drifts from the `scan.review.latest` contract.
 */
export type ScanFindingReview = NonNullable<
	Awaited<ReturnType<typeof orpcClient.projects.scan.review.latest>>["review"]
>;

/** One AI proposal in a {@link ScanFindingReview}. */
export type ScanFindingReviewProposal = NonNullable<
	ScanFindingReview["proposals"]
>[number];

export type ScanSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type ScanCategory = "SECURITY" | "ACCESSIBILITY";
export type FindingStatus = "OPEN" | "RESOLVED" | "DISMISSED";
export type EnforcementMode = "WARN" | "BLOCK";
export type ScanStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";

/**
 * History-feed entry types from `orpc.projects.scan.activity`. Drives the
 * per-entry icon in the History dialog. Mirrors the `ScanActivityType` Prisma
 * enum — the AI review lifecycle (started / cancelled / applied) and purge land
 * in the "Findings history" view, so the dialog must render every one of these.
 */
export type ScanActivityType =
	| "SCAN_STARTED"
	| "SCAN_COMPLETED"
	| "SCAN_FAILED"
	| "FINDING_RESOLVED"
	| "FINDING_DISMISSED"
	| "FINDING_REOPENED"
	| "FINDING_CONVERTED"
	| "FINDING_EDITED"
	| "CONFIG_UPDATED"
	| "FINDINGS_PURGED"
	| "FINDINGS_REVIEWED"
	| "REVIEW_STARTED"
	| "REVIEW_CANCELLED"
	| "FINDINGS_GROUPED";

export type FeatureDraftingStage =
	| "PLACEHOLDER"
	| "PASSIVE_ANALYSIS"
	| "ACTIVE_ANALYSIS"
	| "SANITY_CHECK"
	| "DRAFT"
	| "PUBLISHED"
	| "DECLINED"
	| "CLOSED";

/** A scan is in-flight while PENDING or RUNNING. */
export function isScanActive(status: ScanStatus | null | undefined): boolean {
	return status === "PENDING" || status === "RUNNING";
}

/**
 * The error the cancel-scan procedure writes when a user aborts a scan
 * (`packages/api/.../scan/cancel-scan.ts`). The data model has no CANCELLED
 * status — a cancel is stored as FAILED with this sentinel — so the UI keys on
 * it to keep a deliberate cancel on the calm settled summary rather than the
 * alarming "scan failed" error surface meant for genuine failures.
 */
const SCAN_CANCELLED_ERROR = "Cancelled by user";

/** Whether a FAILED scan row is really a user-initiated cancellation. Pure. */
export function isCancelledScan(
	scan: Pick<ProjectScan, "status" | "error">,
): boolean {
	return scan.status === "FAILED" && scan.error === SCAN_CANCELLED_ERROR;
}

/** Severity order, worst-first — drives grouping and sorting. */
export const SEVERITY_ORDER: readonly ScanSeverity[] = [
	"CRITICAL",
	"HIGH",
	"MEDIUM",
	"LOW",
] as const;

/**
 * Worst-first rank per severity (CRITICAL = 0 … LOW = 3) — the index into
 * {@link SEVERITY_ORDER}. Used to order groups and to compute a group's
 * effective (max) severity.
 */
const SEVERITY_RANK: Record<ScanSeverity, number> = {
	CRITICAL: 0,
	HIGH: 1,
	MEDIUM: 2,
	LOW: 3,
};

/**
 * The highest (worst) severity among a set of findings — a group inherits the
 * priority of its most severe member, so it sections and badges as that
 * severity. Defaults to `LOW` for an empty set (never happens for a real
 * group). Pure + exported for unit testing.
 */
export function worstSeverity(
	severities: readonly ScanSeverity[],
): ScanSeverity {
	let rank = SEVERITY_RANK.LOW;
	for (const s of severities) {
		const r = SEVERITY_RANK[s] ?? SEVERITY_RANK.LOW;
		if (r < rank) {
			rank = r;
		}
	}
	return SEVERITY_ORDER[rank] ?? "LOW";
}

export const SEVERITY_LABEL: Record<ScanSeverity, string> = {
	CRITICAL: "Critical",
	HIGH: "High",
	MEDIUM: "Medium",
	LOW: "Low",
};

/**
 * Severity → Badge variant. Variants resolve to design tokens:
 * - destructive → `--destructive` (critical / high)
 * - warning     → `--highlight` family (medium)
 * - secondary   → `--secondary` (low — calm, "informational")
 */
export const SEVERITY_BADGE_VARIANT: Record<
	ScanSeverity,
	NonNullable<BadgeProps["variant"]>
> = {
	CRITICAL: "destructive",
	HIGH: "destructive",
	MEDIUM: "warning",
	LOW: "secondary",
};

/**
 * Solid background classes for the severity rail and the proportional summary
 * bar — the same token system as {@link SEVERITY_BADGE_VARIANT}, but rendered
 * as a solid fill rather than the Badge's tint. Critical and High share the
 * `destructive` token (matching their Badge variant) and are distinguished by
 * opacity so the proportional bar stays readable.
 */
export const SEVERITY_FILL_CLASS: Record<ScanSeverity, string> = {
	CRITICAL: "bg-destructive",
	HIGH: "bg-destructive/70",
	MEDIUM: "bg-yellow-500",
	LOW: "bg-secondary",
};

export const CATEGORY_LABEL: Record<ScanCategory, string> = {
	SECURITY: "Security",
	ACCESSIBILITY: "Accessibility",
};

export const CATEGORY_BADGE_VARIANT: Record<
	ScanCategory,
	NonNullable<BadgeProps["variant"]>
> = {
	SECURITY: "default",
	ACCESSIBILITY: "info",
};

export const STATUS_LABEL: Record<FindingStatus, string> = {
	OPEN: "Open",
	RESOLVED: "Resolved",
	DISMISSED: "Dismissed",
};

export const STATUS_BADGE_VARIANT: Record<
	FindingStatus,
	NonNullable<BadgeProps["variant"]>
> = {
	OPEN: "outline",
	RESOLVED: "success",
	DISMISSED: "secondary",
};

export const SCAN_STATUS_LABEL: Record<ScanStatus, string> = {
	PENDING: "Pending",
	RUNNING: "Running",
	COMPLETED: "Completed",
	FAILED: "Failed",
};

export const SCAN_STATUS_BADGE_VARIANT: Record<
	ScanStatus,
	NonNullable<BadgeProps["variant"]>
> = {
	PENDING: "outline",
	RUNNING: "info",
	COMPLETED: "success",
	FAILED: "destructive",
};

/**
 * The visual indicator for a branch's scan state: an icon, a human label, and a
 * design-token color class (never a hardcoded hex). A visible label always
 * accompanies the icon in the UI, so state never rests on color alone (WCAG
 * 1.4.1); the SCANNING loader is spun under `motion-safe:` at the call site.
 *
 *   SCANNED     → Check   / `text-secondary`        (settled — up to date)
 *   STALE       → Clock   / `text-highlight`        (amber — drifted since scan)
 *   NOT_SCANNED → Minus   / `text-muted-foreground` (never scanned)
 *   SCANNING    → Loader2 / `text-primary`          (in flight)
 */
export type BranchStatusIndicator = {
	icon: LucideIcon;
	label: string;
	className: string;
};

const BRANCH_STATUS_INDICATOR: Record<
	BranchScanStatusValue,
	BranchStatusIndicator
> = {
	SCANNED: { icon: CheckIcon, label: "Scanned", className: "text-secondary" },
	STALE: { icon: ClockIcon, label: "Stale", className: "text-highlight" },
	NOT_SCANNED: {
		icon: MinusIcon,
		label: "Not scanned",
		className: "text-muted-foreground",
	},
	SCANNING: {
		icon: Loader2Icon,
		label: "Scanning",
		className: "text-primary",
	},
};

/** The icon/label/token-class indicator for a branch's scan state. Pure. */
export function branchStatusIndicator(
	status: BranchScanStatusValue,
): BranchStatusIndicator {
	return BRANCH_STATUS_INDICATOR[status];
}

/** Human-readable maturation-gate options for the auto-scan Select. */
export const MATURATION_GATE_OPTIONS: ReadonlyArray<{
	value: FeatureDraftingStage;
	label: string;
}> = [
	{ value: "PLACEHOLDER", label: "Placeholder" },
	{ value: "PASSIVE_ANALYSIS", label: "Passive analysis" },
	{ value: "ACTIVE_ANALYSIS", label: "Active analysis" },
	{ value: "SANITY_CHECK", label: "Sanity check" },
	{ value: "DRAFT", label: "Draft" },
	{ value: "PUBLISHED", label: "Published" },
	{ value: "DECLINED", label: "Declined" },
	{ value: "CLOSED", label: "Closed" },
];

export const ENFORCEMENT_OPTIONS: ReadonlyArray<{
	value: EnforcementMode;
	label: string;
	description: string;
}> = [
	{
		value: "WARN",
		label: "Warn (non-blocking)",
		description:
			"Surface findings without stopping a feature from progressing.",
	},
	{
		value: "BLOCK",
		label: "Block",
		description:
			"Every scan auto-blocks each work item a finding is tied to (with the finding as the reason). Stays blocked until removed manually.",
	},
];

export const RULE_CATEGORY_OPTIONS: ReadonlyArray<{
	value: ScanCategory;
	label: string;
}> = [
	{ value: "SECURITY", label: "Security" },
	{ value: "ACCESSIBILITY", label: "Accessibility" },
];

export const RULE_SEVERITY_OPTIONS: ReadonlyArray<{
	value: ScanSeverity;
	label: string;
}> = SEVERITY_ORDER.map((value) => ({ value, label: SEVERITY_LABEL[value] }));

/** Status options for the per-finding triage editor (override the AI triage). */
export const FINDING_STATUS_OPTIONS: ReadonlyArray<{
	value: FindingStatus;
	label: string;
}> = (["OPEN", "RESOLVED", "DISMISSED"] as const).map((value) => ({
	value,
	label: STATUS_LABEL[value],
}));

/**
 * Which scanner engine produced a finding. There's no dedicated column for this
 * — a finding is produced by exactly one engine, derivable from its category and
 * `ruleSource` prefix (the workflow tags Semgrep findings `"Semgrep: …"` and
 * git-history secrets `"Secret history: …"`; everything else is an AI reviewer):
 *
 *   - SEMGREP          — Semgrep static analysis (SAST) over the connected repo
 *   - GIT_HISTORY      — gitleaks over the full commit history
 *   - AI_ACCESSIBILITY — the LLM accessibility review of features + documents
 *   - AI_SECURITY      — the LLM security review of features + documents
 */
export type FindingScanner =
	| "AI_SECURITY"
	| "AI_ACCESSIBILITY"
	| "SEMGREP"
	| "GIT_HISTORY";

/** Prefixes the scan workflow stamps onto a finding's `ruleSource` per engine. */
const SEMGREP_RULE_PREFIX = "Semgrep:";
const GIT_HISTORY_RULE_PREFIX = "Secret history:";

/**
 * Derive the engine that captured a finding from its `ruleSource` + `category`.
 * Pure + exported so it can be unit-tested independently of the UI.
 */
export function getFindingScanner(
	finding: Pick<ScanFinding, "ruleSource" | "category">,
): FindingScanner {
	const ruleSource = finding.ruleSource ?? "";
	if (ruleSource.startsWith(SEMGREP_RULE_PREFIX)) {
		return "SEMGREP";
	}
	if (ruleSource.startsWith(GIT_HISTORY_RULE_PREFIX)) {
		return "GIT_HISTORY";
	}
	return finding.category === "ACCESSIBILITY"
		? "AI_ACCESSIBILITY"
		: "AI_SECURITY";
}

/** Short chip label per engine. Both AI reviewers read the same Fabric content,
 *  so they share one label — the Category badge already distinguishes them. */
export const FINDING_SCANNER_LABEL: Record<FindingScanner, string> = {
	AI_SECURITY: "AI review",
	AI_ACCESSIBILITY: "AI review",
	SEMGREP: "Semgrep",
	GIT_HISTORY: "Git history",
};

/** Longer, plain-language description shown in the expanded finding body. */
export const FINDING_SCANNER_DESCRIPTION: Record<FindingScanner, string> = {
	AI_SECURITY:
		"Found by the AI security review of this project's features and documents (OWASP Top 10 + your custom rules).",
	AI_ACCESSIBILITY:
		"Found by the AI accessibility review of this project's features and documents (WCAG 2.1 AA + your custom rules).",
	SEMGREP:
		"Found by Semgrep static analysis (SAST) over your connected repository's code.",
	GIT_HISTORY:
		"Found by the gitleaks scan of your repository's full commit history.",
};

/**
 * The four scan engines, in display order, with the short label the
 * scan-type/engine filter (G12) shows. AI Security and AI Accessibility are
 * listed separately here (unlike the per-finding chip, which shares "AI review"
 * for the two) because the filter selects on the underlying `scanner` value the
 * server translates to a `ruleSource` prefix + `category` where-clause.
 */
export const SCANNER_FILTER_OPTIONS: ReadonlyArray<{
	value: FindingScanner;
	label: string;
}> = [
	{ value: "AI_SECURITY", label: "AI Security" },
	{ value: "AI_ACCESSIBILITY", label: "AI Accessibility" },
	{ value: "SEMGREP", label: "Semgrep" },
	{ value: "GIT_HISTORY", label: "Git history" },
];

// ── Confidence (G1) ──────────────────────────────────────────────────────────

export type ConfidenceLevel = "HIGH" | "MEDIUM" | "LOW";

/** How findings can be ordered in the list (G1 adds confidence). */
export type FindingSort = "severity" | "confidence";

/**
 * The deterministic confidence floor. A finding whose confidence is BELOW this
 * value is "low confidence" (`confidenceLevel(...) === "LOW"`) and is collapsed
 * out of the default findings view behind a "Show N low-confidence findings"
 * affordance — never deleted, always one click away. Mirrors the backend
 * `DEFAULT_CONFIDENCE_FLOOR` (packages/database `queries/projects/scan.ts`), so
 * the client-side split matches what the server considers low-signal. Zero-cost
 * and deterministic: it holds even if the AI false-positive review never ran.
 */
export const DEFAULT_CONFIDENCE_FLOOR = 0.5;

/**
 * Map a stored confidence float (0..1, or null on legacy rows) to a categorical
 * bucket. Pure + exported for unit testing. Thresholds mirror the backend
 * `normalizeConfidence` buckets: high ≈ 0.9, medium ≈ 0.6, low ≈ 0.3.
 *
 *   ≥ 0.8 → High   ≥ DEFAULT_CONFIDENCE_FLOOR → Medium   else → Low
 *
 * `null` ⇒ no confidence (legacy / not yet re-scanned) — callers skip the chip.
 */
export function confidenceLevel(
	value: number | null | undefined,
): ConfidenceLevel | null {
	if (value == null || Number.isNaN(value)) {
		return null;
	}
	if (value >= 0.8) {
		return "HIGH";
	}
	if (value >= DEFAULT_CONFIDENCE_FLOOR) {
		return "MEDIUM";
	}
	return "LOW";
}

/**
 * Whether a finding's confidence is low enough to collapse out of the default
 * view — i.e. `confidence < DEFAULT_CONFIDENCE_FLOOR` (equivalently
 * `confidenceLevel(...) === "LOW"`). A `null`/legacy confidence is deliberately
 * NOT low: those rows have no signal to hide behind and stay visible. Pure +
 * exported for unit testing; kept consistent with {@link confidenceLevel} so the
 * split can never drift from the chip.
 */
export function isLowConfidence(value: number | null | undefined): boolean {
	return confidenceLevel(value) === "LOW";
}

export const CONFIDENCE_LABEL: Record<ConfidenceLevel, string> = {
	HIGH: "High",
	MEDIUM: "Medium",
	LOW: "Low",
};

/**
 * Short label for the confidence chip, e.g. "High confidence". `null` ⇒ no
 * chip. Kept as a helper so the chip and the legend stay in sync.
 */
export function confidenceLabel(
	value: number | null | undefined,
): string | null {
	const level = confidenceLevel(value);
	return level ? `${CONFIDENCE_LABEL[level]} confidence` : null;
}

/**
 * Confidence → Badge variant. Confidence is advisory, not a risk level, so it
 * deliberately does NOT reuse the severity palette: high = `secondary`
 * (calm/settled), medium = `outline`, low = `warning` (amber — "treat with
 * care, the engine was unsure"). Text always accompanies the chip, so meaning
 * never rests on color alone (WCAG 1.4.1).
 */
export const CONFIDENCE_BADGE_VARIANT: Record<
	ConfidenceLevel,
	NonNullable<BadgeProps["variant"]>
> = {
	HIGH: "secondary",
	MEDIUM: "outline",
	LOW: "warning",
};

// ── Review proposals (G7) ────────────────────────────────────────────────────

/** AI verdict on a finding during a false-positive review. */
export type ReviewVerdict = "confirmed" | "false_positive" | "uncertain";

export const REVIEW_VERDICT_LABEL: Record<ReviewVerdict, string> = {
	confirmed: "Looks real",
	false_positive: "Likely false positive",
	uncertain: "Uncertain",
};

/**
 * Verdict → Badge variant. Advisory tone, not alarmist: "confirmed" is neutral
 * (`outline` — the finding stands as-is), "false_positive" is `secondary`
 * (a calm suggestion to dismiss), "uncertain" is `warning` (amber — needs a
 * human). Color is never the only signal; the label text always shows.
 */
export const REVIEW_VERDICT_BADGE_VARIANT: Record<
	ReviewVerdict,
	NonNullable<BadgeProps["variant"]>
> = {
	confirmed: "outline",
	false_positive: "secondary",
	uncertain: "warning",
};

/** The categorical confidence the review emits per proposal. */
export type ProposalConfidence = "high" | "medium" | "low";

export const PROPOSAL_CONFIDENCE_LABEL: Record<ProposalConfidence, string> = {
	high: "High",
	medium: "Medium",
	low: "Low",
};

// ── Finding grouping — "Group into tickets" (spec 2026-07-01) ───────────────

/**
 * The on-demand security/accessibility finding-grouping run — server-inferred
 * so the button and results dialog never drift from the `scan.grouping.latest`
 * contract, mirroring {@link ScanFindingReview}.
 */
export type ScanFindingGrouping = NonNullable<
	Awaited<
		ReturnType<typeof orpcClient.projects.scan.grouping.latest>
	>["grouping"]
>;

/**
 * The typed `results` blob a grouping run produces. After the PROPOSE phase
 * (AWAITING_REVIEW) it carries the review proposals (`proposedCreate` /
 * `proposedUpdate` / `declinedThemes`, plus skipped/failed); after APPLY
 * (COMPLETED) the accepted proposals move into `createdThemes`/`updatedThemes`.
 * Every array is optional, so consumers read each with `?? []`.
 */
export type GroupingRunResults = NonNullable<ScanFindingGrouping["results"]>;

export type GroupingProposalCreate = NonNullable<
	GroupingRunResults["proposedCreate"]
>[number];
export type GroupingProposalUpdate = NonNullable<
	GroupingRunResults["proposedUpdate"]
>[number];
export type GroupingCreatedTheme = NonNullable<
	GroupingRunResults["createdThemes"]
>[number];
export type GroupingUpdatedTheme = NonNullable<
	GroupingRunResults["updatedThemes"]
>[number];
export type GroupingSkippedTheme = NonNullable<
	GroupingRunResults["skippedThemes"]
>[number];
export type GroupingFailedTheme = NonNullable<
	GroupingRunResults["failedThemes"]
>[number];

/** The grouping run lifecycle status (server-inferred). */
export type GroupingRunStatus = ScanFindingGrouping["status"];

/** Statuses where the run is still working and the poll should keep firing. */
export function isGroupingRunning(
	status: GroupingRunStatus | undefined,
): boolean {
	return (
		status === "PENDING" || status === "RUNNING" || status === "APPLYING"
	);
}

/** Which outcome bucket a theme landed in — drives the results dialog's badge. */
export type GroupingOutcome = "created" | "updated" | "skipped" | "failed";

export const GROUPING_OUTCOME_LABEL: Record<GroupingOutcome, string> = {
	created: "Created",
	updated: "Updated",
	skipped: "Skipped",
	failed: "Failed",
};

/**
 * Outcome → Badge variant. "Created" is a positive outcome (`success`, like a
 * resolved finding); "updated" is informational (`info`, like a running scan);
 * "skipped" is calm/settled (`secondary`, like a dismissed finding — nothing
 * to do); "failed" is `destructive`. Text always accompanies the badge, so
 * meaning never rests on color alone (WCAG 1.4.1).
 */
export const GROUPING_OUTCOME_BADGE_VARIANT: Record<
	GroupingOutcome,
	NonNullable<BadgeProps["variant"]>
> = {
	created: "success",
	updated: "info",
	skipped: "secondary",
	failed: "destructive",
};

// ── Severity rubric (G5) ─────────────────────────────────────────────────────

/** One editable severity-rubric row. */
export type SeverityRubricEntry = {
	severity: ScanSeverity;
	definition: string;
};

/**
 * CVSS-aligned seeded defaults for the per-project severity rubric (G5). Shown
 * pre-filled in the editor and injected into the scanner prompt when the project
 * hasn't customized them. The server seeds the same text when `severityRubric`
 * is null; this mirror keeps the editor populated before the first save.
 */
export const DEFAULT_SEVERITY_RUBRIC: ReadonlyArray<SeverityRubricEntry> = [
	{
		severity: "CRITICAL",
		definition:
			"Directly exploitable with severe impact — remote code execution, authentication bypass, or exposure of secrets/PII. Address before shipping.",
	},
	{
		severity: "HIGH",
		definition:
			"Serious risk or a hard accessibility barrier that is likely exploitable or blocks users, but needs a precondition or some effort. Prioritize a fix.",
	},
	{
		severity: "MEDIUM",
		definition:
			"Moderate impact or limited exploitability — defense-in-depth gaps, or issues affecting some users in some flows. Should be addressed.",
	},
	{
		severity: "LOW",
		definition:
			"Minor or informational — hardening suggestions, edge cases, or cosmetic issues with little practical impact. Fix when convenient.",
	},
];

// ── Visual grouping (G9) ─────────────────────────────────────────────────────

/**
 * A finding's location grouping key + label, used to collapse closely-tied
 * findings (same feature / file / commit) into one expandable section. This is
 * purely a VIEW concern — nothing is merged at the data layer, and every finding
 * stays individually actionable inside its group.
 *
 * Resolution order (most specific first):
 *   1. A linked feature → `F-XXX` / `B-XXX` identifier (from `story` or parsed
 *      out of `location`), so all findings about one feature group together.
 *   2. The raw `location` string (a repo file path, a commit, a UI region).
 *   3. Fallback bucket for findings with no location at all.
 *
 * Pure + exported for unit testing.
 */
export type FindingGroupKey = {
	/** Stable key for grouping / map lookups. */
	key: string;
	/** Human label for the group header. */
	label: string;
};

const UNGROUPED_KEY = "__ungrouped__";

export function findingGroupKey(
	finding: Pick<ScanFinding, "location" | "story" | "storyId">,
): FindingGroupKey {
	const story = finding.story;
	if (story?.identifier) {
		return { key: `story:${story.id}`, label: story.identifier };
	}
	const location = finding.location?.trim();
	if (location) {
		// If a feature identifier is embedded in the location, key on it so
		// rows about the same feature collapse together even without `story`.
		const featureId = location.match(/\b[FB]-\d+\b/)?.[0];
		if (featureId) {
			return { key: `feature:${featureId}`, label: featureId };
		}
		return { key: `loc:${location}`, label: location };
	}
	return { key: UNGROUPED_KEY, label: "No specific location" };
}

// ── Theme grouping — cluster findings by (category, ruleSource) (view-only) ──

/**
 * A finding's THEME identity: the `(category, ruleSource)` pair the backend's
 * "Group into tickets" run buckets on — one theme becomes one ticket. This is a
 * pure VIEW helper for the findings list's "Group by theme" mode: it clusters
 * the already-loaded findings client-side and NEVER calls the grouping backend
 * or reproduces its hashed `StoryTag` value. Because the backend keys a theme on
 * the SAME `(category, ruleSource)` pair, a theme shown here corresponds 1:1 to
 * the ticket a grouping run would create/update — so a run's result themes can
 * be matched back to these groups by {@link themeComboKey} without the hash.
 *
 * Pure + exported for unit testing.
 */
export type ScanFindingThemeKey = {
	/** Stable, collision-free map key: `category::ruleSource`. */
	key: string;
	category: ScanCategory;
	ruleSource: string;
};

/**
 * Join a `(category, ruleSource)` pair into the stable theme key used both to
 * bucket findings AND to match a grouping-run result theme back to its findings.
 * `category` is a fixed two-member enum with no `::`, so the `::` split is
 * unambiguous and two distinct pairs can never collide.
 */
export function themeComboKey(
	category: ScanCategory,
	ruleSource: string,
): string {
	return `${category}::${ruleSource}`;
}

export function findingThemeKey(
	finding: Pick<ScanFinding, "category" | "ruleSource">,
): ScanFindingThemeKey {
	const category = finding.category as ScanCategory;
	const ruleSource = finding.ruleSource ?? "";
	return { key: themeComboKey(category, ruleSource), category, ruleSource };
}

/**
 * Format an elapsed duration (ms) as a compact human string: `45s`, `2m 05s`,
 * `1h 03m 09s`. Drives the live running-scan timer. Negative inputs clamp to 0.
 */
export function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	if (hours > 0) {
		return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
	}
	if (minutes > 0) {
		return `${minutes}m ${pad(seconds)}s`;
	}
	return `${seconds}s`;
}
