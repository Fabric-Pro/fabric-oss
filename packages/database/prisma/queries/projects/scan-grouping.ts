/**
 * Database queries for the security/accessibility finding-grouping pipeline
 * (spec `2026-07-01-security-finding-tickets`).
 *
 * A `ScanFindingGrouping` is a single manually-triggered run: it reads the
 * project's latest COMPLETED scan's OPEN findings, groups them by
 * `(category, ruleSource)` into themes, and for each theme either creates one
 * new backlog ticket or posts an incremental `AGENT` comment on an existing
 * one. Unlike `ScanFindingReview`, there is no "apply" step — tickets/
 * comments are written during the run itself, so this file has no
 * proposal-confirmation surface.
 *
 * Tenant isolation mirrors `scan.ts` / `scan-review.ts`: callers (oRPC
 * procedures) gate access via `hasProjectAccess` + permission middleware;
 * every write carries userId/organizationId so the `user_owned` RLS policy
 * and the app-layer XOR filter both hold.
 */

import { TERMINAL_DRAFTING_STAGES } from "../../../utils";
import { db, type Prisma } from "../../client";
import type {
	GroupingRunStatus,
	ScanCategory,
	ScanSeverity,
	StoryPriority,
} from "../../generated/client";
import { getLatestProjectScan } from "./scan";

// =============================================================================
// Types
// =============================================================================

/**
 * One theme's outcome as recorded in `ScanFindingGrouping.results` (JSON) —
 * the durable record the results dialog renders and the headline toast is
 * computed from (see spec §8.2/§9.2). `themeKey` is the deterministic
 * `StoryTag` value identifying the theme (see the temporal layer's
 * `themeTagValue`); which array a theme lands in (`createdThemes` /
 * `updatedThemes` / `skippedThemes` / `failedThemes`) is itself the outcome
 * discriminant, so no separate `outcome` field is carried on each entry.
 */
export type GroupingThemeSummary = {
	category: ScanCategory;
	ruleSource: string;
	themeKey: string;
	findingCount: number;
};

/** A theme that got a brand-new ticket this run. */
export type GroupingCreatedTheme = GroupingThemeSummary & {
	storyId: string;
	storyIdentifier: string;
};

/** A theme whose existing ticket received an incremental `AGENT` comment. */
export type GroupingUpdatedTheme = GroupingThemeSummary & {
	storyId: string;
	storyIdentifier: string;
	newFindingCount: number;
};

/** A theme whose existing ticket had nothing new to report — no write made. */
export type GroupingSkippedTheme = GroupingThemeSummary & {
	storyId: string;
	storyIdentifier: string;
	reason: string;
};

/** A theme that failed to process (e.g. draft/LLM failure, over the soft cap). */
export type GroupingFailedTheme = GroupingThemeSummary & {
	reason: string;
};

/**
 * A proposed NEW ticket (kind BUG) for a theme, awaiting review. Carries the
 * fully-drafted title/body/priority so apply persists it verbatim (no
 * re-draft), the fingerprints to record for future incremental dedup, and the
 * optional `severity` when a large theme was split by severity (distribution).
 */
export type GroupingProposalCreate = GroupingThemeSummary & {
	severity: ScanSeverity | null;
	title: string;
	body: string;
	priority: StoryPriority;
	fingerprints: string[];
};

/** A proposed UPDATE — an incremental `AGENT` comment on an existing ticket. */
export type GroupingProposalUpdate = GroupingThemeSummary & {
	storyId: string;
	storyIdentifier: string;
	newFindingCount: number;
	commentBody: string;
	newFingerprints: string[];
	cumulativeFingerprints: string[];
};

/**
 * The typed shape of `ScanFindingGrouping.results` (stored as `Json?`).
 * After the PROPOSE phase (AWAITING_REVIEW) it carries the review proposals
 * (`proposedCreate`/`proposedUpdate`/`declinedThemes` + skipped/failed); after
 * APPLY (COMPLETED) the accepted proposals move into `createdThemes`/
 * `updatedThemes`. Every array is optional so a partially-populated run is a
 * valid shape at either phase.
 */
export type GroupingRunResults = {
	proposedCreate?: GroupingProposalCreate[];
	proposedUpdate?: GroupingProposalUpdate[];
	declinedThemes?: GroupingProposalCreate[];
	skippedThemes?: GroupingSkippedTheme[];
	failedThemes?: GroupingFailedTheme[];
	createdThemes?: GroupingCreatedTheme[];
	updatedThemes?: GroupingUpdatedTheme[];
};

/**
 * A current OPEN finding from the project's latest COMPLETED scan, projected
 * into the minimal shape the grouping pipeline needs: enough to bucket into a
 * `(category, ruleSource)` theme, feed the ticket-drafting prompt, and diff
 * against previously-known fingerprints. Mirrors `FindingForReview`'s
 * projection philosophy (`scan-review.ts`), plus `fingerprint` — essential
 * here for the incremental-update diff (§5.3/§8.2), which that sibling
 * feature doesn't need.
 */
export type FindingForGrouping = {
	id: string;
	category: ScanCategory;
	severity: ScanSeverity;
	title: string;
	description: string;
	remediation: string;
	ruleSource: string;
	location: string | null;
	/** 0..1 derived confidence from the originating scan; null for legacy rows. */
	confidence: number | null;
	/** Stable cross-scan dedup key; null for legacy pre-fingerprint rows. */
	fingerprint: string | null;
};

// =============================================================================
// Grouping runs
// =============================================================================

/**
 * Create a `ScanFindingGrouping` row in PENDING. Tenant fields are required
 * for RLS / XOR. The workflow then drives it RUNNING → COMPLETED / FAILED.
 * `scanId` is intentionally not accepted here — it isn't resolved until the
 * workflow's findings-gathering step runs, and is written later via
 * `updateScanFindingGrouping`.
 */
export async function createScanFindingGrouping(data: {
	projectId: string;
	userId: string;
	organizationId?: string | null;
	workflowId?: string | null;
}) {
	return db.scanFindingGrouping.create({
		data: {
			projectId: data.projectId,
			status: "PENDING",
			workflowId: data.workflowId ?? null,
			userId: data.userId,
			organizationId: data.organizationId ?? null,
		},
	});
}

/** A grouping run by id, scoped to its project for tenant safety. */
export async function getScanFindingGrouping(
	groupingId: string,
	projectId: string,
) {
	return db.scanFindingGrouping.findFirst({
		where: { id: groupingId, projectId },
	});
}

/**
 * The most-recent grouping run for a project (drives `scan.grouping.latest`
 * and the button's polling/status). Optionally scoped to a status. Null ⇒
 * grouping has never been run for this project.
 */
export async function getLatestScanFindingGrouping(
	projectId: string,
	opts: { status?: GroupingRunStatus } = {},
) {
	return db.scanFindingGrouping.findFirst({
		where: {
			projectId,
			...(opts.status ? { status: opts.status } : {}),
		},
		orderBy: { createdAt: "desc" },
	});
}

/**
 * Patch a grouping run. Only the provided fields are written, so the
 * workflow can advance it incrementally (mark RUNNING with startedAt; record
 * the resolved scanId; persist results + counts + telemetry + COMPLETED; or
 * FAILED with an error). Scoping by `projectId` is the caller's
 * responsibility at the procedure layer; the workflow holds the id.
 */
export async function updateScanFindingGrouping(
	groupingId: string,
	data: {
		status?: GroupingRunStatus;
		scanId?: string | null;
		results?: GroupingRunResults;
		createdCount?: number;
		updatedCount?: number;
		skippedCount?: number;
		failedCount?: number;
		themeCount?: number;
		findingCount?: number;
		modelName?: string | null;
		inputTokens?: number | null;
		outputTokens?: number | null;
		costUsd?: number | null;
		durationMs?: number | null;
		error?: string | null;
		workflowId?: string | null;
		startedAt?: Date | null;
		completedAt?: Date | null;
	},
) {
	const patch: Prisma.ScanFindingGroupingUpdateInput = {};
	if (data.status !== undefined) {
		patch.status = data.status;
	}
	if (data.scanId !== undefined) {
		patch.scanId = data.scanId;
	}
	if (data.results !== undefined) {
		// Stored as JSON; the typed shape is structurally JSON-safe.
		patch.results = data.results as unknown as Prisma.InputJsonValue;
	}
	if (data.createdCount !== undefined) {
		patch.createdCount = data.createdCount;
	}
	if (data.updatedCount !== undefined) {
		patch.updatedCount = data.updatedCount;
	}
	if (data.skippedCount !== undefined) {
		patch.skippedCount = data.skippedCount;
	}
	if (data.failedCount !== undefined) {
		patch.failedCount = data.failedCount;
	}
	if (data.themeCount !== undefined) {
		patch.themeCount = data.themeCount;
	}
	if (data.findingCount !== undefined) {
		patch.findingCount = data.findingCount;
	}
	if (data.modelName !== undefined) {
		patch.modelName = data.modelName;
	}
	if (data.inputTokens !== undefined) {
		patch.inputTokens = data.inputTokens;
	}
	if (data.outputTokens !== undefined) {
		patch.outputTokens = data.outputTokens;
	}
	if (data.costUsd !== undefined) {
		patch.costUsd = data.costUsd;
	}
	if (data.durationMs !== undefined) {
		patch.durationMs = data.durationMs;
	}
	if (data.error !== undefined) {
		patch.error = data.error;
	}
	if (data.workflowId !== undefined) {
		patch.workflowId = data.workflowId;
	}
	if (data.startedAt !== undefined) {
		patch.startedAt = data.startedAt;
	}
	if (data.completedAt !== undefined) {
		patch.completedAt = data.completedAt;
	}
	return db.scanFindingGrouping.update({
		where: { id: groupingId },
		data: patch,
	});
}

/**
 * Is there already a non-terminal grouping run for this project? Used to
 * dedupe the "Group into tickets" trigger so a double-click / concurrent
 * request can't spawn a pile of redundant runs (mirrors `hasActiveScanReview`
 * / `hasActiveScan`).
 */
export async function hasActiveScanFindingGrouping(
	projectId: string,
): Promise<boolean> {
	const active = await db.scanFindingGrouping.findFirst({
		where: {
			projectId,
			// A run awaiting review or mid-apply is still "active" — don't let a
			// second run start until the current proposals are applied/declined
			// or the run is cancelled.
			status: {
				in: ["PENDING", "RUNNING", "AWAITING_REVIEW", "APPLYING"],
			},
		},
		select: { id: true },
	});
	return active !== null;
}

// =============================================================================
// Findings to group
// =============================================================================

/**
 * The project's latest COMPLETED scan's OPEN findings (D4) — the eligible
 * set the grouping pipeline reads at the start of a run.
 *
 * Reuses the existing `getLatestProjectScan(projectId, { status:
 * "COMPLETED" })` helper (unmodified, from `scan.ts`) rather than
 * hand-rolling scan resolution — that helper already returns `null`
 * gracefully (never throws) when the project has never completed a scan.
 *
 * CRITICAL CONTRACT: returns `[]` — never throws — both when no COMPLETED
 * scan exists yet AND when the resolved scan has zero OPEN findings. A fresh,
 * never-scanned project must not fail the grouping workflow; "gated off /
 * nothing to do" is a graceful empty result here, exactly like the access
 * gate (`checkAgentAccessActivity`) treats "access is off" as a successful,
 * zero-count run rather than an error. Downstream (the grouping workflow)
 * depends on this exact contract.
 *
 * Deliberately uncapped (no `take` limit): AC1 requires ingesting 100% of a
 * project's eligible findings without silently dropping any. The pipeline's
 * only sanctioned truncation point is the THEME-level
 * `MAX_THEMES_PER_GROUPING_RUN` safety valve (recorded as explicit
 * `failed`/`theme_limit_exceeded` outcomes, never a silent drop) — adding an
 * uncoordinated finding-level cap here would risk silently dropping findings
 * beneath that documented threshold.
 */
export async function getEligibleFindingsForGrouping(
	projectId: string,
): Promise<FindingForGrouping[]> {
	const latestCompletedScan = await getLatestProjectScan(projectId, {
		status: "COMPLETED",
	});
	if (!latestCompletedScan) {
		return [];
	}

	return db.scanFinding.findMany({
		where: {
			projectId,
			scanId: latestCompletedScan.id,
			status: "OPEN",
		},
		select: {
			id: true,
			category: true,
			severity: true,
			title: true,
			description: true,
			remediation: true,
			ruleSource: true,
			location: true,
			confidence: true,
			fingerprint: true,
		},
		// Deterministic, highest-impact-first ordering (mirrors
		// `listOpenFindingsForReview`); not itself load-bearing for grouping
		// since themes are grouped in-memory downstream by the caller.
		orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
	});
}

// =============================================================================
// Dedup — the sole, authoritative mechanism for this feature (§8.1)
// =============================================================================

/**
 * Find an existing, open (non-terminal) story tagged with the given
 * `StoryTag` value, scoped to the project. This is the sole, authoritative
 * dedup mechanism for the whole grouping feature — reused verbatim for BOTH
 * the per-theme ticket lookup (`themeTagValue(category, ruleSource)`) and
 * the fixed `PREREQUISITE_ACCESS_TAG` lookup (§8.3); callers differ only in
 * the `tagValue` they pass.
 *
 * "Open, non-terminal" has no fixed enum (grounding correction — §8.1):
 * `ProjectStoryStatus` is a per-project model, not an enum, so "terminal"
 * means the boolean `isFinal` flag on whichever status row the story
 * currently points to — NOT a hardcoded status-name string. A story whose
 * `draftingStage` is `DECLINED`/`CLOSED` (a separate, roadmap-visibility
 * axis) is also treated as not-covering-anymore, reusing the shared
 * `TERMINAL_DRAFTING_STAGES` constant so this stays in lockstep with the
 * dedup guard / AI-Update terminal-state gate's definition of "terminal".
 *
 * Ordered by `createdAt` ascending so a (should-never-happen, but
 * defensively handled) duplicate tag match resolves deterministically to the
 * original/oldest ticket for that theme.
 */
export async function findOpenStoryByThemeTag(
	projectId: string,
	tagValue: string,
) {
	return db.userStory.findFirst({
		where: {
			projectId,
			tags: { some: { value: tagValue } },
			status: { isFinal: false },
			draftingStage: { notIn: TERMINAL_DRAFTING_STAGES },
		},
		orderBy: { createdAt: "asc" },
	});
}

// =============================================================================
// Fingerprint tracking (§8.2) — reuses ScanActivity, no new table
// =============================================================================

/**
 * Tolerant parser for `ScanActivity.metadata.fingerprints` — mirrors the
 * "drop anything malformed, never throw" convention used throughout
 * `scan.ts`'s JSON-column parsers (`parseScanCustomRules` et al.). Exported
 * (pure, no DB) so it's directly unit-testable.
 */
export function parseFingerprintsMetadata(
	value: Prisma.JsonValue | null | undefined,
): string[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return [];
	}
	const fingerprints = (value as Record<string, unknown>).fingerprints;
	if (!Array.isArray(fingerprints)) {
		return [];
	}
	return fingerprints.filter((f): f is string => typeof f === "string");
}

/**
 * The cumulative set of fingerprints already known to be summarized into a
 * given ticket by this pipeline, as of the most recent run that touched it.
 *
 * Reuses the existing `ScanActivity.storyId` + `ScanActivity.metadata`
 * columns rather than a new join table (§8.2): every "created"/"updated"
 * theme outcome writes one `FINDINGS_GROUPED` row whose `metadata.fingerprints`
 * is already the cumulative (previous ∪ newly-added) set — so a single
 * `findFirst` ordered by `createdAt desc` is correct and sufficient; no
 * aggregation across historical rows is needed. Returns `[]` if the ticket
 * has never been touched by this pipeline (the AC10 manually-pre-tagged-
 * ticket case, §8.4).
 */
export async function getLastKnownFingerprints(
	projectId: string,
	storyId: string,
): Promise<string[]> {
	const lastActivity = await db.scanActivity.findFirst({
		where: { projectId, storyId, type: "FINDINGS_GROUPED" },
		orderBy: { createdAt: "desc" },
		select: { metadata: true },
	});
	return parseFingerprintsMetadata(lastActivity?.metadata);
}

// =============================================================================
// Declined-theme store (durable "stays declined" across runs)
// =============================================================================

/**
 * One entry in `ProjectScanConfig.declinedGroupingThemes` (JSON). A theme the
 * user declined in the review dialog; `themeKey` is the load-bearing identity
 * (the rest is audit/display). A later propose run surfaces a theme whose key
 * is here as "declined" instead of proposing it as a fresh create.
 */
export type DeclinedGroupingTheme = {
	themeKey: string;
	category: string;
	ruleSource: string;
	severity?: string | null;
	declinedByUserId?: string | null;
	declinedAt: string;
};

/** Tolerant parser — drop anything malformed, never throw. */
export function parseDeclinedGroupingThemes(
	value: Prisma.JsonValue | null | undefined,
): DeclinedGroupingTheme[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: DeclinedGroupingTheme[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			continue;
		}
		const e = entry as Record<string, unknown>;
		if (typeof e.themeKey !== "string") {
			continue;
		}
		out.push({
			themeKey: e.themeKey,
			category: typeof e.category === "string" ? e.category : "",
			ruleSource: typeof e.ruleSource === "string" ? e.ruleSource : "",
			severity: typeof e.severity === "string" ? e.severity : null,
			declinedByUserId:
				typeof e.declinedByUserId === "string"
					? e.declinedByUserId
					: null,
			declinedAt: typeof e.declinedAt === "string" ? e.declinedAt : "",
		});
	}
	return out;
}

/** All declined themes for a project (empty if the config row/column is unset). */
export async function getDeclinedGroupingThemes(
	projectId: string,
): Promise<DeclinedGroupingTheme[]> {
	const cfg = await db.projectScanConfig.findUnique({
		where: { projectId },
		select: { declinedGroupingThemes: true },
	});
	return parseDeclinedGroupingThemes(cfg?.declinedGroupingThemes ?? null);
}

/**
 * Merge `themes` into the project's declined store (dedupe by themeKey, last
 * write wins). Upserts the 1:1 config row so a decline works even if scanning
 * was never explicitly configured; tenant fields are required for the create
 * branch (RLS / XOR).
 */
export async function addDeclinedGroupingThemes(
	projectId: string,
	tenant: { userId: string; organizationId?: string | null },
	themes: DeclinedGroupingTheme[],
): Promise<void> {
	if (themes.length === 0) {
		return;
	}
	const existing = await getDeclinedGroupingThemes(projectId);
	const byKey = new Map(existing.map((t) => [t.themeKey, t]));
	for (const t of themes) {
		byKey.set(t.themeKey, t);
	}
	const merged = [...byKey.values()];
	await db.projectScanConfig.upsert({
		where: { projectId },
		create: {
			projectId,
			userId: tenant.userId,
			organizationId: tenant.organizationId ?? null,
			declinedGroupingThemes: merged as unknown as Prisma.InputJsonValue,
		},
		update: {
			declinedGroupingThemes: merged as unknown as Prisma.InputJsonValue,
		},
	});
}

/**
 * Remove one theme from the declined store (the "Re-add" path). Returns the
 * removed entry, or null if it wasn't declined. Safe no-op when absent.
 */
export async function removeDeclinedGroupingTheme(
	projectId: string,
	themeKey: string,
): Promise<DeclinedGroupingTheme | null> {
	const existing = await getDeclinedGroupingThemes(projectId);
	const found = existing.find((t) => t.themeKey === themeKey) ?? null;
	if (!found) {
		return null;
	}
	const remaining = existing.filter((t) => t.themeKey !== themeKey);
	await db.projectScanConfig.update({
		where: { projectId },
		data: {
			declinedGroupingThemes:
				remaining as unknown as Prisma.InputJsonValue,
		},
	});
	return found;
}
