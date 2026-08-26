/**
 * Shared, pure constants for the QA tab — enum literals, ordered lists
 * for filters/selects, and the token-driven presentation maps consumed by the
 * status chip, the run-result pill, the priority bars and the stat strip. No
 * React here so the hook + the chips + the filters can all share it without a
 * component import cycle. Mirrors the structure of the decisions module's
 * `constants.ts`.
 */

export type TestCaseState = "PROPOSED" | "DRAFT" | "READY" | "CLOSED";
export type TestCasePriority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type AutomationStatus = "NOT_AUTOMATED" | "PLANNED" | "AUTOMATED";
/** Denormalized current run result (Prisma `TestResult`). */
export type TestResult =
	| "NOT_RUN"
	| "PASSED"
	| "FAILED"
	| "BLOCKED"
	| "SKIPPED";
/** PM-sync lifecycle (Prisma `PmSyncStatus`). */
export type PmSyncStatus = "PENDING" | "SUCCESS" | "CONFLICT" | "FAILED";

export const TEST_CASE_STATES: TestCaseState[] = [
	"PROPOSED",
	"DRAFT",
	"READY",
	"CLOSED",
];
export const TEST_CASE_PRIORITIES: TestCasePriority[] = [
	"LOW",
	"MEDIUM",
	"HIGH",
	"CRITICAL",
];
export const AUTOMATION_STATUSES: AutomationStatus[] = [
	"NOT_AUTOMATED",
	"PLANNED",
	"AUTOMATED",
];
/** Every run result, ordered for display (worst-to-best is intentional). */
export const TEST_RESULTS: TestResult[] = [
	"NOT_RUN",
	"PASSED",
	"FAILED",
	"BLOCKED",
	"SKIPPED",
];
/**
 * What a PERSON can record against a case. Everything except SKIPPED, which
 * describes what an automated suite did — a human who chose not to run a case
 * records BLOCKED or resets it to NOT_RUN. Mirrors the server's `record-result`
 * input enum, so the two cannot drift.
 */
export type RecordableResult = Exclude<TestResult, "SKIPPED">;
/**
 * The subset offered in the inline / bulk "mark" menu. NOT_RUN is reachable via
 * the row menu and the project-wide reset, not here, so it is a curated subset
 * of {@link RecordableResult} rather than a different vocabulary.
 */
export const MARKABLE_RESULTS: RecordableResult[] = [
	"PASSED",
	"FAILED",
	"BLOCKED",
];
export const TEST_PLAN_STATES = ["ACTIVE", "INACTIVE"] as const;
export type TestPlanState = (typeof TEST_PLAN_STATES)[number];

/** i18n key suffixes (under `projects.testCases.*`) for each enum value. */
export const STATE_I18N_KEY: Record<TestCaseState, string> = {
	PROPOSED: "states.proposed",
	DRAFT: "states.draft",
	READY: "states.ready",
	CLOSED: "states.closed",
};
export const PRIORITY_I18N_KEY: Record<TestCasePriority, string> = {
	LOW: "priorities.low",
	MEDIUM: "priorities.medium",
	HIGH: "priorities.high",
	CRITICAL: "priorities.critical",
};
export const AUTOMATION_I18N_KEY: Record<AutomationStatus, string> = {
	NOT_AUTOMATED: "automation.notAutomated",
	PLANNED: "automation.planned",
	AUTOMATED: "automation.automated",
};
export const RESULT_I18N_KEY: Record<TestResult, string> = {
	NOT_RUN: "result.notRun",
	PASSED: "result.passed",
	FAILED: "result.failed",
	BLOCKED: "result.blocked",
	SKIPPED: "result.skipped",
};

/**
 * Sort keys for the cases list. Ordering is applied SERVER-SIDE (the list API
 * takes `sort` + `direction`), so it holds across the whole result set rather
 * than the loaded page. Must stay in step with `TEST_CASE_SORT_KEYS` in
 * `@repo/database` — the API validates against that list.
 */
export const SORT_KEYS = ["order", "priority", "recentRun", "title"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDirection = "asc" | "desc";
export const SORT_I18N_KEY: Record<SortKey, string> = {
	order: "sort.order",
	priority: "sort.priority",
	recentRun: "sort.recentRun",
	title: "sort.title",
};

/**
 * The direction each key sorts by until the reader flips it. Mirrors
 * `TEST_CASE_SORT_DEFAULT_DIRECTION` server-side: most urgent / most recent
 * first, but alphabetical and manual order ascending.
 */
export const SORT_DEFAULT_DIRECTION: Record<SortKey, SortDirection> = {
	order: "asc",
	priority: "desc",
	recentRun: "desc",
	title: "asc",
};

/**
 * Presentation tones. The semantic colour rides on a small dot / icon (and a
 * faint pill tint); the label text stays `text-foreground` so it always clears
 * WCAG AA contrast regardless of the accent. Meaning is therefore carried by the
 * dot/icon + the words, never colour alone. All colours are design-system tokens
 * (`--secondary`/`--highlight`/`--muted-foreground`/`--destructive`/`--primary`)
 * — no hex.
 */
export type Tone =
	| "secondary"
	| "highlight"
	| "muted"
	| "destructive"
	| "primary";

export const TONE_CLASSES: Record<
	Tone,
	{
		/** Solid dot background. */
		dot: string;
		/** Outline-chip border + faint tint. */
		pill: string;
		/** Token text/icon colour (used by icons + accented numerals). */
		text: string;
		/** Solid fill (stat-strip bar segments, priority bars, rings). */
		solid: string;
	}
> = {
	secondary: {
		dot: "bg-secondary",
		pill: "border-secondary/30 bg-secondary/10",
		text: "text-secondary",
		solid: "bg-secondary",
	},
	highlight: {
		dot: "bg-highlight",
		pill: "border-highlight/30 bg-highlight/10",
		text: "text-highlight",
		solid: "bg-highlight",
	},
	muted: {
		dot: "bg-muted-foreground",
		pill: "border-border/70 bg-muted/60",
		text: "text-muted-foreground",
		solid: "bg-muted-foreground",
	},
	destructive: {
		dot: "bg-destructive",
		pill: "border-destructive/30 bg-destructive/10",
		text: "text-destructive",
		solid: "bg-destructive",
	},
	primary: {
		dot: "bg-primary",
		pill: "border-primary/30 bg-primary/10",
		text: "text-primary",
		solid: "bg-primary",
	},
};

/** State → tone. ready = green, draft = amber, closed = neutral. */
export const STATE_TONE: Record<TestCaseState, Tone> = {
	READY: "secondary",
	DRAFT: "highlight",
	// Primary, not highlight: a proposed case is the only state that ASKS the
	// reader for a decision, and it must not read the same as a draft they are
	// simply still writing.
	PROPOSED: "primary",
	CLOSED: "muted",
};
/** Priority → tone. critical = red, high = amber, medium = brand, low = neutral. */
export const PRIORITY_TONE: Record<TestCasePriority, Tone> = {
	CRITICAL: "destructive",
	HIGH: "highlight",
	MEDIUM: "primary",
	LOW: "muted",
};
/**
 * Run result → tone. passed = green, failed = red, blocked = amber,
 * not-run = neutral. A SKIPPED test is neutral, NOT amber: the suite chose not
 * to run it, so it is not "needs attention" the way a blocked one is.
 */
export const RESULT_TONE: Record<TestResult, Tone> = {
	PASSED: "secondary",
	FAILED: "destructive",
	BLOCKED: "highlight",
	NOT_RUN: "muted",
	SKIPPED: "muted",
};

/** Filled bar-count (1–4) per priority — the non-colour signal for the bars. */
export const PRIORITY_LEVEL: Record<TestCasePriority, number> = {
	LOW: 1,
	MEDIUM: 2,
	HIGH: 3,
	CRITICAL: 4,
};

/** Every status value the chip can render (states ∪ automation ∪ pm-sync). */
export type ChipStatus = TestCaseState | AutomationStatus | PmSyncStatus;

/**
 * Default (English) presentation per status. Callers may pass a translated
 * `label` to the chip; otherwise this label is used so the chip is renderable
 * — and unit-testable — without an i18n provider (mirrors `DecisionStatusBadge`).
 */
export const CHIP_CONFIG: Record<
	ChipStatus,
	// `primary` was previously excluded only because no status needed it;
	// `TONE_CLASSES` has always defined it. PROPOSED does need it — it is the one
	// status that asks the reader for a decision, and reusing DRAFT's highlight
	// would make "still being written" and "awaiting your approval" look alike.
	{ tone: Tone; label: string }
> = {
	// Test-case state
	READY: { tone: "secondary", label: "Ready" },
	DRAFT: { tone: "highlight", label: "Draft" },
	PROPOSED: { tone: "primary", label: "Proposed" },
	CLOSED: { tone: "muted", label: "Closed" },
	// Automation status
	AUTOMATED: { tone: "secondary", label: "Automated" },
	PLANNED: { tone: "highlight", label: "Planned" },
	NOT_AUTOMATED: { tone: "muted", label: "Not automated" },
	// PM-sync status
	SUCCESS: { tone: "secondary", label: "Connected" },
	PENDING: { tone: "highlight", label: "Pending" },
	CONFLICT: { tone: "destructive", label: "Conflict" },
	FAILED: { tone: "destructive", label: "Failed" },
};
